import type {
  ContentBlock,
  PromptResponse,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk"
import type { ExecutorEvent, SessionId, ToolCallStatus, Usage } from "@shoalwork/contracts"

// Text of the agent and of its tools is data (R14): it is recorded, never interpreted.
const OUTPUT_MAX_CHARS = 4000
const INPUT_MAX_CHARS = 2000
const RESULT_MAX_CHARS = 100_000

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

// Policy tool names for ACP kinds, so one policy file covers every executor. The rest keep the raw kind
// (unknown to the policy: external, so they ask).
const TOOL_NAMES: Readonly<Partial<Record<ToolKind, string>>> = {
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  move: "Edit",
  search: "Grep",
  fetch: "WebFetch",
}

export const toolNameOf = (kind: ToolKind | null | undefined): string =>
  TOOL_NAMES[kind ?? "other"] ?? kind ?? "other"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The command a tool call runs, when the agent put it in rawInput as a string.
export const commandOf = (rawInput: unknown): string | undefined =>
  isRecord(rawInput) && typeof rawInput.command === "string" ? rawInput.command : undefined

const boundedInput = (rawInput: unknown): unknown => {
  if (rawInput === undefined || rawInput === null) return {}
  try {
    return JSON.stringify(rawInput).length > INPUT_MAX_CHARS ? { truncated: true } : rawInput
  } catch {
    return { truncated: true }
  }
}

const textOf = (block: ContentBlock): string | undefined => (block.type === "text" ? block.text : undefined)

const outputOf = (content: ReadonlyArray<ToolCallContent> | undefined): string | undefined => {
  const parts: string[] = []
  for (const item of content ?? []) {
    if (item.type === "content") {
      const text = textOf(item.content)
      if (text !== undefined) parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : clip(parts.join("\n"), OUTPUT_MAX_CHARS)
}

const exitCodeOf = (rawOutput: unknown): number | undefined => {
  if (!isRecord(rawOutput)) return undefined
  const code = rawOutput.exitCode ?? rawOutput.exit_code
  return typeof code === "number" && Number.isInteger(code) ? code : undefined
}

// Every path a tool call names: its locations and the files of its diffs, each once.
export const pathsOf = (
  content: ReadonlyArray<ToolCallContent> | null | undefined,
  locations: ReadonlyArray<ToolCallLocation> | null | undefined,
): ReadonlyArray<string> => {
  const fromDiffs = (content ?? []).flatMap((item) => (item.type === "diff" ? [item.path] : []))
  return Array.from(new Set([...(locations ?? []).map((location) => location.path), ...fromDiffs]))
}

const paths = (tc: ToolState): ReadonlyArray<string> => pathsOf(tc.content, tc.locations)

type ToolState = {
  kind: ToolKind
  title: string
  rawInput: unknown
  rawOutput: unknown
  content: ReadonlyArray<ToolCallContent> | undefined
  locations: ReadonlyArray<ToolCallLocation> | undefined
  startedEmitted: boolean
  settled: boolean
}

type ToolPatch = {
  readonly kind?: ToolKind | null | undefined
  readonly title?: string | null | undefined
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly content?: ReadonlyArray<ToolCallContent> | null | undefined
  readonly locations?: ReadonlyArray<ToolCallLocation> | null | undefined
}

const statusOf = (status: string | null | undefined): ToolCallStatus | undefined =>
  status === "completed" ? "completed" : status === "failed" ? "failed" : undefined

export type AcpMapper = {
  // Events for one session/update. Updates the mapper does not know are skipped.
  readonly push: (update: SessionUpdate) => ReadonlyArray<ExecutorEvent>
  // Terminal events for the session/prompt response (usage first, then done|error).
  readonly finish: (
    response: PromptResponse,
    sessionId: SessionId,
    seconds: number,
  ) => ReadonlyArray<ExecutorEvent>
}

const toUsage = (response: PromptResponse, seconds: number): Usage | undefined => {
  const used = response.usage
  if (used === undefined || used === null) return undefined
  const whole = (n: number | null | undefined): number => Math.max(0, Math.round(n ?? 0))
  return {
    tokensIn: whole(used.inputTokens),
    tokensOut: whole(used.outputTokens) + whole(used.thoughtTokens),
    cacheRead: whole(used.cachedReadTokens),
    cacheWrite: whole(used.cachedWriteTokens),
    usd: 0,
    seconds,
  }
}

const stopError = (reason: PromptResponse["stopReason"]): ExecutorEvent | undefined => {
  switch (reason) {
    case "end_turn":
      return undefined
    case "max_tokens":
      return { kind: "error", code: "budget", message: "the agent stopped: token limit reached" }
    case "max_turn_requests":
      return { kind: "error", code: "max_turns", message: "the agent stopped: turn request limit reached" }
    case "refusal":
      return { kind: "error", code: "unknown", message: "the agent refused the prompt" }
    case "cancelled":
      return { kind: "error", code: "unknown", message: "the agent ended the turn as cancelled" }
  }
}

export const makeAcpMapper = (options: { readonly resumed?: boolean } = {}): AcpMapper => {
  const tools = new Map<string, ToolState>()
  let reply = ""
  // session/update carries the cumulative cost of the session; usage events carry what each update added.
  let lastCost = 0
  // After session/load the first cost seen is what the session had already spent: a baseline, not new spend.
  let baseline = options.resumed === true

  const merge = (id: string, patch: ToolPatch): ToolState => {
    const before = tools.get(id)
    const next: ToolState = {
      kind: patch.kind ?? before?.kind ?? "other",
      title: patch.title ?? before?.title ?? "",
      rawInput: patch.rawInput ?? before?.rawInput,
      rawOutput: patch.rawOutput ?? before?.rawOutput,
      content: patch.content ?? before?.content,
      locations: patch.locations ?? before?.locations,
      startedEmitted: before?.startedEmitted ?? false,
      settled: before?.settled ?? false,
    }
    tools.set(id, next)
    return next
  }

  const generic = (tc: ToolState, status: ToolCallStatus) => {
    const resource = tc.locations?.[0]?.path
    return {
      kind: "tool_call",
      call: {
        tool: toolNameOf(tc.kind),
        input: boundedInput(tc.rawInput),
        ...(resource === undefined ? {} : { resource }),
      },
      status,
    } satisfies ExecutorEvent
  }

  const tool = (
    id: string,
    patch: ToolPatch,
    rawStatus: string | null | undefined,
  ): ReadonlyArray<ExecutorEvent> => {
    const tc = merge(id, patch)
    if (tc.settled) return []
    const status = statusOf(rawStatus)
    if (status === undefined) {
      // Commands and edits are reported once they end; the other tools also when they start.
      if (tc.kind === "execute" || tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") return []
      if (tc.startedEmitted) return []
      tc.startedEmitted = true
      return [generic(tc, "started")]
    }
    tc.settled = true
    if (tc.kind === "execute") {
      const output = outputOf(tc.content)
      const exitCode = exitCodeOf(tc.rawOutput)
      return [
        {
          kind: "command",
          cmd: clip(commandOf(tc.rawInput) ?? tc.title, INPUT_MAX_CHARS),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(output === undefined ? {} : { output }),
        },
      ]
    }
    const edited = tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move"
    if (edited && status === "completed" && paths(tc).length > 0) {
      return paths(tc).map((path): ExecutorEvent => ({ kind: "file_edit", path }))
    }
    return [generic(tc, status)]
  }

  return {
    push: (update) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = textOf(update.content)
          if (text === undefined || text === "") return []
          reply = clip(`${reply}${text}`, RESULT_MAX_CHARS)
          return [{ kind: "text", text }]
        }
        case "agent_thought_chunk": {
          const text = textOf(update.content)
          return text === undefined || text === "" ? [] : [{ kind: "thinking", text }]
        }
        case "tool_call":
          return tool(update.toolCallId, update, update.status)
        case "tool_call_update":
          return tool(update.toolCallId, update, update.status)
        case "usage_update": {
          const cost = update.cost
          if (cost === undefined || cost === null || cost.currency !== "USD") return []
          if (baseline) {
            baseline = false
            lastCost = cost.amount
            return []
          }
          const added = cost.amount - lastCost
          lastCost = Math.max(lastCost, cost.amount)
          if (!(added > 0)) return []
          return [
            {
              kind: "usage",
              usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: added, seconds: 0 },
            },
          ]
        }
        default:
          return []
      }
    },
    finish: (response, sessionId, seconds) => {
      const usage = toUsage(response, seconds)
      const failure = stopError(response.stopReason)
      const end: ExecutorEvent = failure ?? { kind: "done", result: reply, artifacts: [], sessionId }
      return usage === undefined ? [end] : [{ kind: "usage", usage }, end]
    },
  }
}
