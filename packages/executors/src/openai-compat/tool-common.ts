import { isAbsolute, relative, resolve, sep } from "node:path"
import type {
  BotId,
  ExecutorEvent,
  PermissionMode,
  PolicyDecision,
  Risk,
  TankError,
  ToolCall,
} from "@shoalwork/contracts"
import type { ExecResult, TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import type { McpToolHost } from "./mcp-tools.js"

// Shared by the three tools. The model's output is untrusted (R14): every call is decoded, judged by the Policy as the
// matching Claude Code tool (Read / Write / Bash) and only then run through the Tank. Nothing here throws: a refusal
// is a tool result the model reads and adapts to.

// The Policy of the product, as the adapter needs it: `Policy.evaluate` fits this type (same as AcpPolicy).
export type OpenAICompatPolicy = (
  botId: BotId,
  call: ToolCall,
  context: { readonly cwd: string; readonly roots: ReadonlyArray<string> },
) => Effect.Effect<PolicyDecision>

export const COMMAND_TIMEOUT_MS = 120_000
// stdout+stderr of run_command; the Tank stops accumulating and kills the command here.
export const COMMAND_OUTPUT_MAX_BYTES = 8 * 1024
export const READ_OUTPUT_MAX_CHARS = 32 * 1024
export const FILE_MAX_BYTES = 2 * 1024 * 1024
// Type/size probes (realpath, test, wc) never legitimately take long or print much.
export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_OUTPUT_MAX_BYTES = 4096
export const PATH_MAX_CHARS = 4096

export type ToolDeps = {
  readonly tank: TankShape
  readonly ctx: TankContext
  readonly botId: BotId
  readonly policy: OpenAICompatPolicy
  readonly mode: PermissionMode
  // The Bot's MCP tools (T-083); absent: none are offered.
  readonly mcp?: McpToolHost | undefined
}

export type ToolOutcome =
  // `content` goes back to the model as the tool message.
  | { readonly kind: "result"; readonly content: string; readonly events: ReadonlyArray<ExecutorEvent> }
  // The Policy asks: the run ends with approval_needed and a later run continues (T-054).
  | { readonly kind: "ask"; readonly action: ToolCall; readonly risk: Risk }

export const failed = (call: ToolCall, message: string): ToolOutcome => ({
  kind: "result",
  content: `error: ${message}`,
  events: [{ kind: "tool_call", call, status: "failed" }],
})

export const tankMessage = (error: TankError): string =>
  error.op === "path" ? "path is outside the workspace" : `file operation failed (${error.op})`

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]` : text

export const parseArgs = <A>(schema: Schema.Codec<A, unknown>, raw: string): Effect.Effect<A, string> =>
  Effect.try({
    try: (): unknown => JSON.parse(raw === "" ? "{}" : raw),
    catch: () => "arguments are not valid JSON",
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() => "arguments do not match the tool schema"),
      ),
    ),
  )

// A Policy that dies is a deny, never a pass.
const DENY: PolicyDecision = { effect: "deny", risk: "irreversible" }

// allow -> undefined (go on); deny -> a result; ask -> the pause.
export const judge = (
  deps: ToolDeps,
  asked: ToolCall,
  shown: ToolCall,
): Effect.Effect<ToolOutcome | undefined> =>
  deps.policy(deps.botId, asked, { cwd: deps.ctx.cwd, roots: [deps.ctx.home] }).pipe(
    Effect.catchCause(() => Effect.succeed(DENY)),
    Effect.map((decision): ToolOutcome | undefined => {
      if (decision.effect === "allow") return undefined
      if (decision.effect === "ask") return { kind: "ask", action: asked, risk: decision.risk }
      return failed(shown, `${asked.tool} was denied by the policy`)
    }),
  )

export const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Lexical check only; symlinks are the Tank's and the probes' business.
export const insideCwd = (cwd: string, path: string): string | undefined => {
  const target = resolve(cwd, path)
  return isInside(cwd, target) ? target : undefined
}

export const invalidPath = (path: string): boolean => path.includes("\0") || path.length > PATH_MAX_CHARS

// A short, bounded command run as the Bot (no shell). Timeout, failure or truncation is `undefined`.
export const probe = (deps: ToolDeps, cmd: ReadonlyArray<string>): Effect.Effect<ExecResult | undefined> =>
  deps.tank.exec(deps.ctx, cmd, { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_OUTPUT_MAX_BYTES }).pipe(
    Effect.map((result) => (result.timedOut || result.outputTruncated === true ? undefined : result)),
    Effect.catch(() => Effect.succeed(undefined)),
  )
