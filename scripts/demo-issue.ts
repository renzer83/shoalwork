// Sprint 1 acceptance: a Bot from bots/*.yaml implements a GitHub issue and the Lead opens the PR.
// Usage: pnpm demo:issue --repo https://github.com/<owner>/<repo> --issue <n> [--bot dev-demo]
// Without LIVE=1 only the arguments are checked. With LIVE=1 it reads the issue with the host's `gh`,
// sends the task to the core over HTTP (APP_URL, API_TOKEN) and waits for the verdict.
import { execFile } from "node:child_process"
import { parseArgs, promisify } from "node:util"

const run = promisify(execFile)

const BASE_BRANCH = "main"
const POLL_MS = 5_000
const WAIT_MS = 40 * 60_000
const CODE_TIER = "heavy"
const ACCEPTANCE = ["pnpm test"]
const BUDGET = { tokens: 500_000, seconds: 1800, usd: 5 } as const
const REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/
const BOT_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/
const TERMINAL_STATES: ReadonlyArray<string> = ["done", "failed", "cancelled"]

export interface DemoArgs {
  readonly repo: string
  readonly ownerRepo: string
  readonly issue: number
  readonly bot: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Pure: returns the parsed arguments or the first problem found, never touches the network.
export const parseDemoArgs = (argv: ReadonlyArray<string>): DemoArgs | string => {
  let values: {
    readonly repo?: string | undefined
    readonly issue?: string | undefined
    readonly bot?: string | undefined
  }
  try {
    values = parseArgs({
      args: [...argv],
      options: { repo: { type: "string" }, issue: { type: "string" }, bot: { type: "string" } },
      strict: true,
    }).values
  } catch (cause) {
    return cause instanceof Error ? cause.message : "invalid arguments"
  }
  if (values.repo === undefined) return "missing --repo <https://github.com/owner/repo>"
  const match = REPO_URL.exec(values.repo)
  if (match === null) return "--repo must be a https://github.com/<owner>/<repo> URL"
  if (values.issue === undefined) return "missing --issue <number>"
  const issue = Number(values.issue)
  if (!Number.isInteger(issue) || issue < 1) return "--issue must be a positive integer"
  const bot = values.bot ?? "dev-demo"
  if (!BOT_NAME.test(bot)) return "--bot must be a Bot name (lowercase letters, digits and dashes)"
  const [, owner, name] = match
  return { repo: values.repo, ownerRepo: `${owner}/${name}`, issue, bot }
}

const readIssue = async (ownerRepo: string, issue: number): Promise<{ title: string; body: string }> => {
  // argv only: no shell, the values never get interpreted.
  const { stdout } = await run("gh", [
    "issue",
    "view",
    String(issue),
    "--repo",
    ownerRepo,
    "--json",
    "title,body",
  ])
  const parsed: unknown = JSON.parse(stdout)
  if (!isRecord(parsed) || typeof parsed.title !== "string") throw new Error("gh returned no issue title")
  return { title: parsed.title, body: typeof parsed.body === "string" ? parsed.body : "" }
}

const requestJson = async (
  baseUrl: string,
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<unknown> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${response.status}`)
  return payload
}

const botIdFor = async (baseUrl: string, token: string, name: string): Promise<string> => {
  const payload = await requestJson(baseUrl, token, "/bots")
  const bots = isRecord(payload) && Array.isArray(payload.bots) ? payload.bots : []
  const found = bots.find((bot): bot is Record<string, unknown> => isRecord(bot) && bot.name === name)
  if (found === undefined || typeof found.id !== "string") throw new Error(`unknown bot name: ${name}`)
  return found.id
}

const main = async (): Promise<number> => {
  const parsed = parseDemoArgs(process.argv.slice(2))
  if (typeof parsed === "string") {
    console.error(parsed)
    return 2
  }
  if (process.env.LIVE !== "1") {
    console.log(`arguments ok: ${parsed.ownerRepo}#${parsed.issue} for bot ${parsed.bot}`)
    console.log("dry run: set LIVE=1 to read the issue with gh and send the task to the core")
    return 0
  }
  const baseUrl = process.env.APP_URL
  const token = process.env.API_TOKEN
  if (baseUrl === undefined || baseUrl === "") return fail("missing APP_URL")
  if (token === undefined || token === "") return fail("missing API_TOKEN")

  const issue = await readIssue(parsed.ownerRepo, parsed.issue)
  const botId = await botIdFor(baseUrl, token, parsed.bot)
  const prompt = [
    issue.title,
    "",
    issue.body,
    "",
    "Implement, add tests, run the project's test command, do not commit.",
  ].join("\n")
  const created = await requestJson(baseUrl, token, "/tasks", {
    method: "POST",
    body: {
      botId,
      title: issue.title,
      prompt,
      kind: "code",
      repo: { url: parsed.repo, base: BASE_BRANCH, issue: parsed.issue },
      acceptance: ACCEPTANCE,
      budget: BUDGET,
      tier: CODE_TIER,
      origin: "cli",
    },
  })
  const taskId = isRecord(created) && isRecord(created.task) ? created.task.id : undefined
  if (typeof taskId !== "string") throw new Error("the core did not return a task id")
  console.log(`task ${taskId} sent to ${parsed.bot}`)

  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const view = await requestJson(baseUrl, token, `/tasks/${encodeURIComponent(taskId)}`)
    const state = isRecord(view) && typeof view.state === "string" ? view.state : "unknown"
    const verdict = isRecord(view) ? view.verdict : undefined
    if (isRecord(verdict)) {
      console.log(JSON.stringify(verdict, null, 2))
      const evidence = Array.isArray(verdict.evidence) ? verdict.evidence : []
      if (verdict.kind === "ok") console.log(`PR: ${String(evidence[0] ?? "none")}`)
      return verdict.kind === "ok" ? 0 : 1
    }
    if (TERMINAL_STATES.includes(state) || Date.now() > deadline) {
      return fail(`no verdict (state ${state})`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

const fail = (message: string): number => {
  console.error(message)
  return 1
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.filename === process.argv[1]
if (isEntrypoint) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (cause: unknown) => {
      // Messages come from this script or from the core's status codes; never echo tokens or raw bodies.
      console.error(cause instanceof Error ? cause.message : "demo failed")
      process.exitCode = 1
    },
  )
}
