// 48 h soak check for the core. Reads GET /health, the watchdog / error / budget events of the last 48 h
// (GET /events, one stream at a time) and the executor processes (claude / codex) without a core ancestor.
// Prints a PASS/FAIL report; exit code 0 only on PASS. Never prints the API token.
// Usage: pnpm soak:check   (env: APP_URL, API_TOKEN, PORT; the repo-root .env is read when present)
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const WINDOW_MS = 48 * 60 * 60 * 1000
export const REQUIRED_UPTIME_SECONDS = 172_800
// Same cap as MAX_EVENTS in services/core/src/http/routes/events.ts: a full page means "read the next one".
export const PAGE_SIZE = 500
export const SOAK_TYPES = ["watchdog.recovered", "error.raised", "budget.exceeded"] as const
const SYSTEM_STREAM = "system"
const DEFAULT_PORT = 28900
const REQUEST_TIMEOUT_MS = 10_000
const CORE_ENTRY = /services\/core\/(?:dist\/main\.js|src\/main\.ts)/
const REPO_ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".env")

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly command: string
}

export interface SoakEvent {
  readonly type: string
  readonly version: number
  readonly occurredAt: string
  readonly payload: unknown
}

export interface OrphanReport {
  readonly corePids: ReadonlyArray<number>
  readonly executorCount: number
  readonly orphanPids: ReadonlyArray<number>
}

export interface SoakFacts {
  readonly nowMs: number
  readonly baseUrl: string
  // undefined when /health could not be read.
  readonly uptimeSeconds: number | undefined
  // undefined when the events could not be read in full.
  readonly staleStopped: number | undefined
  readonly errorRaised: number
  readonly budgetExceeded: number
  readonly streamsRead: ReadonlyArray<string>
  // undefined when the process table could not be read.
  readonly orphans: OrphanReport | undefined
  readonly problems: ReadonlyArray<string>
}

export interface Check {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

export interface SoakResult {
  readonly pass: boolean
  readonly checks: ReadonlyArray<Check>
}

export interface SoakConfig {
  readonly baseUrl: string
  readonly token: string | undefined
}

// Only the part of fetch the soak uses, so tests can pass a plain function.
export type SoakFetch = (url: string, init: RequestInit) => Promise<Response>

export interface SoakDeps {
  readonly fetchImpl: SoakFetch
  readonly listProcesses: () => Promise<ReadonlyArray<ProcessRow>>
  readonly nowMs: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Pure: validates the shape of GET /health. Returns an error text instead of throwing.
export const parseHealth = (
  body: unknown,
): { readonly ok: boolean; readonly uptimeSeconds: number } | string => {
  if (!isRecord(body)) return "health body is not an object"
  if (typeof body.ok !== "boolean") return "health.ok is missing"
  if (typeof body.uptimeSeconds !== "number" || !Number.isFinite(body.uptimeSeconds)) {
    return "health.uptimeSeconds is missing"
  }
  return { ok: body.ok, uptimeSeconds: body.uptimeSeconds }
}

// Pure: validates GET /bots and returns the bot ids.
export const parseBotIds = (body: unknown): ReadonlyArray<string> | string => {
  if (!isRecord(body) || !Array.isArray(body.bots)) return "bots body has no bots array"
  const ids: string[] = []
  for (const bot of body.bots) {
    if (!isRecord(bot) || typeof bot.id !== "string") return "a bot has no id"
    ids.push(bot.id)
  }
  return ids
}

// Pure: validates one GET /events page.
export const parseEventPage = (body: unknown): ReadonlyArray<SoakEvent> | string => {
  if (!isRecord(body) || !Array.isArray(body.events)) return "events body has no events array"
  const events: SoakEvent[] = []
  for (const raw of body.events) {
    if (!isRecord(raw)) return "an event is not an object"
    if (typeof raw.type !== "string" || typeof raw.occurredAt !== "string")
      return "an event lacks type or occurredAt"
    if (typeof raw.version !== "number" || !Number.isSafeInteger(raw.version)) return "an event lacks version"
    if (!("payload" in raw)) return "an event lacks payload"
    events.push({ type: raw.type, version: raw.version, occurredAt: raw.occurredAt, payload: raw.payload })
  }
  return events
}

export const isInWindow = (event: SoakEvent, nowMs: number): boolean => {
  const at = Date.parse(event.occurredAt)
  return Number.isFinite(at) && at >= nowMs - WINDOW_MS && at <= nowMs
}

// The watchdog recovery that marks a stuck task as stopped: the criterion of the soak.
export const isStaleStopped = (event: SoakEvent): boolean =>
  event.type === "watchdog.recovered" &&
  isRecord(event.payload) &&
  event.payload.what === "stale_task" &&
  event.payload.action === "stopped"

// Reads one stream until a page comes back short. `after` is the version of the last event read.
export const collectStream = async (
  readPage: (streamId: string, after: number) => Promise<ReadonlyArray<SoakEvent>>,
  streamId: string,
): Promise<ReadonlyArray<SoakEvent>> => {
  const collected: SoakEvent[] = []
  let after = 0
  for (;;) {
    const page = await readPage(streamId, after)
    collected.push(...page)
    const last = page.at(-1)
    if (page.length < PAGE_SIZE || last === undefined) {
      return collected
    }
    if (last.version <= after) {
      throw new Error(`events paging did not advance on stream ${streamId}`)
    }
    after = last.version
  }
}

// Pure: parses `ps -A -ww -o pid=,ppid=,command=` output.
export const parsePs = (stdout: string): ReadonlyArray<ProcessRow> => {
  const rows: ProcessRow[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1] ?? 0), ppid: Number(match[2] ?? 0), command: match[3] ?? "" })
  }
  return rows
}

const isClaudeBinary = (token: string): boolean =>
  basename(token) === "claude" || token.includes("@anthropic-ai/claude-code")
const isCodexBinary = (token: string): boolean =>
  basename(token) === "codex" || token.includes("@openai/codex")

// Executor children run non-interactively: claude in print or stream-json mode, codex through `exec`.
// Interactive sessions (a person typing in a terminal) do not match.
export const isExecutorCommand = (command: string): boolean => {
  const tokens = command.split(/\s+/)
  const claude = tokens.findIndex(isClaudeBinary)
  if (claude >= 0) {
    return tokens
      .slice(claude + 1)
      .some(
        (token) =>
          token === "-p" ||
          token === "--print" ||
          token.startsWith("--output-format") ||
          token.startsWith("--input-format"),
      )
  }
  const codex = tokens.findIndex(isCodexBinary)
  return codex >= 0 && tokens.slice(codex + 1).includes("exec")
}

const hasCoreAncestor = (
  row: ProcessRow,
  byPid: ReadonlyMap<number, ProcessRow>,
  corePids: ReadonlySet<number>,
): boolean => {
  const seen = new Set<number>()
  let parent = byPid.get(row.ppid)
  while (parent !== undefined && !seen.has(parent.pid)) {
    if (corePids.has(parent.pid)) return true
    seen.add(parent.pid)
    parent = byPid.get(parent.ppid)
  }
  return false
}

// Pure: an executor is an orphan when none of its ancestors is the core process.
export const findOrphans = (rows: ReadonlyArray<ProcessRow>): OrphanReport => {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const))
  const corePids = new Set(rows.filter((row) => CORE_ENTRY.test(row.command)).map((row) => row.pid))
  const executors = rows.filter((row) => isExecutorCommand(row.command))
  const orphanPids = executors.filter((row) => !hasCoreAncestor(row, byPid, corePids)).map((row) => row.pid)
  return { corePids: [...corePids], executorCount: executors.length, orphanPids }
}

// Pure: the verdict. Every criterion must hold and nothing may be unreadable.
export const evaluateSoak = (facts: SoakFacts): SoakResult => {
  const checks: Check[] = []

  checks.push(
    facts.uptimeSeconds === undefined
      ? { name: "core uptime", pass: false, detail: `core not reachable at ${facts.baseUrl}` }
      : {
          name: "core uptime",
          pass: facts.uptimeSeconds >= REQUIRED_UPTIME_SECONDS,
          detail: `${facts.uptimeSeconds}s (required >= ${REQUIRED_UPTIME_SECONDS}s)`,
        },
  )

  checks.push(
    facts.staleStopped === undefined
      ? { name: "watchdog.recovered stale_task/stopped", pass: false, detail: "events not read in full" }
      : {
          name: "watchdog.recovered stale_task/stopped",
          pass: facts.staleStopped === 0,
          detail: `${facts.staleStopped} in the last 48 h (required 0)`,
        },
  )

  if (facts.orphans === undefined) {
    checks.push({
      name: "executor processes without core parent",
      pass: false,
      detail: "process table not readable",
    })
  } else if (facts.orphans.corePids.length === 0) {
    checks.push({
      name: "executor processes without core parent",
      pass: false,
      detail: "core process not found in the process table (pattern services/core/dist/main.js)",
    })
  } else {
    const orphanPids = facts.orphans.orphanPids
    checks.push({
      name: "executor processes without core parent",
      pass: orphanPids.length === 0,
      detail:
        `${facts.orphans.executorCount} executor processes, ${orphanPids.length} without core parent` +
        (orphanPids.length > 0 ? ` (pids ${orphanPids.join(", ")})` : "") +
        " (required 0)",
    })
  }

  return { pass: checks.every((check) => check.pass) && facts.problems.length === 0, checks }
}

const formatCheck = (check: Check): string =>
  `[${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`

// Pure: the printed report. Informational lines never change the verdict.
export const formatReport = (facts: SoakFacts, result: SoakResult): string => {
  const windowStart = new Date(facts.nowMs - WINDOW_MS).toISOString()
  const lines = [
    `SOAK CHECK shoalwork-core at ${facts.baseUrl}`,
    `window: ${windowStart} -> ${new Date(facts.nowMs).toISOString()} (48 h)`,
    ...result.checks.map(formatCheck),
    `[info] error.raised in window: ${facts.errorRaised}`,
    `[info] budget.exceeded in window: ${facts.budgetExceeded}`,
    `[info] streams read: ${facts.streamsRead.length} (system + bot:<id>); task:<id> streams cannot be listed through GET /events`,
    ...facts.problems.map((problem) => `[ERROR] ${problem}`),
    `RESULT: ${result.pass ? "PASS" : "FAIL"}`,
    "",
  ]
  return lines.join("\n")
}

// Error text without the request: fetch errors carry the code of the socket failure, never the token.
const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const code = isRecord(error.cause) && typeof error.cause.code === "string" ? ` (${error.cause.code})` : ""
  return `${error.message}${code}`
}

const getJson = async (
  fetchImpl: SoakFetch,
  url: string,
  token: string | undefined,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` }
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

// Runs every read and returns the facts. Failures become `problems`, never exceptions.
export const runSoak = async (
  config: SoakConfig,
  deps: SoakDeps,
): Promise<{ readonly facts: SoakFacts; readonly result: SoakResult }> => {
  const problems: string[] = []
  const nowMs = deps.nowMs()
  const { baseUrl, token } = config

  let uptimeSeconds: number | undefined
  try {
    const health = await getJson(deps.fetchImpl, `${baseUrl}/health`, undefined)
    const parsed = parseHealth(health.body)
    if (typeof parsed === "string") {
      problems.push(`GET /health (HTTP ${health.status}): ${parsed}`)
    } else {
      uptimeSeconds = parsed.uptimeSeconds
      if (!parsed.ok) problems.push(`GET /health reports the database as failing (HTTP ${health.status})`)
    }
  } catch (error) {
    problems.push(`GET /health failed: ${describe(error)}`)
  }

  let botIds: ReadonlyArray<string> | undefined
  if (token === undefined) {
    problems.push("API_TOKEN is not set (export it or put it in the repo-root .env)")
  } else {
    try {
      const bots = await getJson(deps.fetchImpl, `${baseUrl}/bots`, token)
      if (bots.status !== 200) {
        problems.push(`GET /bots returned HTTP ${bots.status}`)
      } else {
        const parsed = parseBotIds(bots.body)
        if (typeof parsed === "string") problems.push(`GET /bots: ${parsed}`)
        else botIds = parsed
      }
    } catch (error) {
      problems.push(`GET /bots failed: ${describe(error)}`)
    }
  }

  let staleStopped: number | undefined
  let errorRaised = 0
  let budgetExceeded = 0
  const streamsRead: string[] = []
  if (token !== undefined && botIds !== undefined) {
    const readPage = async (streamId: string, after: number): Promise<ReadonlyArray<SoakEvent>> => {
      const query = new URLSearchParams({
        stream: streamId,
        after: String(after),
        types: SOAK_TYPES.join(","),
      })
      const response = await getJson(deps.fetchImpl, `${baseUrl}/events?${query.toString()}`, token)
      if (response.status !== 200) throw new Error(`GET /events returned HTTP ${response.status}`)
      const parsed = parseEventPage(response.body)
      if (typeof parsed === "string") throw new Error(parsed)
      return parsed
    }
    const streams = [SYSTEM_STREAM, ...botIds.map((id) => `bot:${id}`)]
    let complete = true
    let stale = 0
    for (const streamId of streams) {
      try {
        const events = await collectStream(readPage, streamId)
        streamsRead.push(streamId)
        for (const event of events) {
          if (!isInWindow(event, nowMs)) continue
          if (isStaleStopped(event)) stale += 1
          if (event.type === "error.raised") errorRaised += 1
          if (event.type === "budget.exceeded") budgetExceeded += 1
        }
      } catch (error) {
        complete = false
        problems.push(`events of stream ${streamId} not read: ${describe(error)}`)
      }
    }
    staleStopped = complete ? stale : undefined
  }

  let orphans: OrphanReport | undefined
  try {
    orphans = findOrphans(await deps.listProcesses())
  } catch (error) {
    problems.push(`process table not readable: ${describe(error)}`)
  }

  const facts: SoakFacts = {
    nowMs,
    baseUrl,
    uptimeSeconds,
    staleStopped,
    errorRaised,
    budgetExceeded,
    streamsRead,
    orphans,
    problems,
  }
  return { facts, result: evaluateSoak(facts) }
}

const readProcessTable = (): Promise<ReadonlyArray<ProcessRow>> =>
  new Promise((resolvePromise, rejectPromise) => {
    // argv only, no shell.
    const child = spawn("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(parsePs(stdout))
      else rejectPromise(new Error(`ps exited with code ${code}`))
    })
  })

const loadRepoEnv = (): string | undefined => {
  if (!existsSync(REPO_ENV_FILE)) return undefined
  try {
    process.loadEnvFile(REPO_ENV_FILE)
    return undefined
  } catch (error) {
    return `could not read ${REPO_ENV_FILE}: ${describe(error)}`
  }
}

const resolvePort = (raw: string | undefined): number => {
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

const isEntrypoint = (metaUrl: string): boolean =>
  process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href

const main = async (): Promise<void> => {
  const envProblem = loadRepoEnv()
  if (envProblem !== undefined) {
    process.stdout.write(`RESULT: FAIL\n[ERROR] ${envProblem}\n`)
    process.exitCode = 1
    return
  }
  const env = process.env
  const token = env.API_TOKEN === undefined || env.API_TOKEN === "" ? undefined : env.API_TOKEN
  const baseUrl = (env.APP_URL ?? `http://127.0.0.1:${resolvePort(env.PORT)}`).replace(/\/+$/, "")
  const { facts, result } = await runSoak(
    { baseUrl, token },
    { fetchImpl: fetch, listProcesses: readProcessTable, nowMs: () => Date.now() },
  )
  process.stdout.write(formatReport(facts, result))
  process.exitCode = result.pass ? 0 : 1
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stdout.write(`RESULT: FAIL\n[ERROR] soak:check crashed: ${describe(error)}\n`)
    process.exitCode = 1
  })
}
