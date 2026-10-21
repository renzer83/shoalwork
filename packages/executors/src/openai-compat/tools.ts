import type { PermissionMode, ToolCall } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { ToolDef } from "./client.js"
import { readFileTool, writeFileTool } from "./file-tools.js"
import { isMcpToolName, type McpToolHost, mcpToolDefs, runMcpTool } from "./mcp-tools.js"
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_TIMEOUT_MS,
  clip,
  failed,
  judge,
  parseArgs,
  type ToolDeps,
  type ToolOutcome,
} from "./tool-common.js"

export type { OpenAICompatPolicy, ToolDeps, ToolOutcome } from "./tool-common.js"
export {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_TIMEOUT_MS,
  FILE_MAX_BYTES,
  READ_OUTPUT_MAX_CHARS,
} from "./tool-common.js"

// The three tools a chat-completions model gets (see tool-common.ts for the rules every call goes through).

const ERROR_CHARS = 300

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const READ_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a text file inside the working directory.",
    parameters: object(
      { path: { type: "string", description: "File path, relative to the working directory." } },
      ["path"],
    ),
  },
}

const WRITE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Create or overwrite a text file inside the working directory.",
    parameters: object(
      {
        path: { type: "string", description: "File path, relative to the working directory." },
        content: { type: "string", description: "Full new content of the file." },
      },
      ["path", "content"],
    ),
  },
}

const RUN_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a program in the working directory. No shell: the first item is the program, the rest its arguments.",
    parameters: object(
      {
        cmd: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: 'Program and arguments, e.g. ["pnpm", "test"].',
        },
      },
      ["cmd"],
    ),
  },
}

// readonly runs can only read; the other modes get all three.
export const toolDefs = (mode: PermissionMode, mcp?: McpToolHost): ReadonlyArray<ToolDef> => [
  ...(mode === "readonly" ? [READ_TOOL] : [READ_TOOL, WRITE_TOOL, RUN_TOOL]),
  ...mcpToolDefs(mcp),
]

const RunArgs = Schema.Struct({ cmd: Schema.NonEmptyArray(Schema.String) })

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+,-]+$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// The Policy parses a shell line; the argv is shown to it quoted the way a shell would need it. A word that would
// read as an env assignment (FOO=1) or is empty is quoted too.
export const shellLine = (cmd: ReadonlyArray<string>): string =>
  cmd
    .map((word) =>
      SAFE_WORD.test(word) && !ASSIGNMENT.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`,
    )
    .join(" ")

const runCommandTool = (deps: ToolDeps, raw: string): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    const args = yield* parseArgs(RunArgs, raw)
    const { cmd } = args
    const line = shellLine(cmd)
    const call: ToolCall = { tool: "run_command", input: { cmd }, resource: line }
    const verdict = yield* judge(deps, { tool: "Bash", input: { command: line } }, call)
    if (verdict !== undefined) return verdict
    return yield* deps.tank
      .exec(deps.ctx, cmd, { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: COMMAND_OUTPUT_MAX_BYTES })
      .pipe(
        Effect.map((result): ToolOutcome => {
          const output = clip(
            `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`,
            COMMAND_OUTPUT_MAX_BYTES,
          )
          const notes =
            (result.timedOut ? `\n[timed out after ${COMMAND_TIMEOUT_MS / 1000}s]` : "") +
            (result.outputTruncated === true
              ? `\n[output cut at ${COMMAND_OUTPUT_MAX_BYTES} bytes; the command was stopped]`
              : "")
          return {
            kind: "result",
            content: `exit code ${result.exitCode}\n${output}${notes}`,
            events: [{ kind: "command", cmd: line, exitCode: result.exitCode, output }],
          }
        }),
        Effect.catch((error) =>
          Effect.succeed(
            failed(call, `command could not run (${error.op}): ${String(error.cause).slice(0, ERROR_CHARS)}`),
          ),
        ),
      )
  }).pipe(
    Effect.catch((message: string) =>
      Effect.succeed(failed({ tool: "run_command", input: { cmd: [] } }, message)),
    ),
  )

// Names the model may call in this mode; anything else is a tool result error (never an exception).
export const runTool = (deps: ToolDeps, name: string, rawArgs: string): Effect.Effect<ToolOutcome> => {
  const offered = toolDefs(deps.mode, deps.mcp).some((tool) => tool.function.name === name)
  if (!offered) {
    return Effect.succeed(
      failed(
        { tool: name.slice(0, 64), input: {} },
        `tool ${JSON.stringify(name.slice(0, 64))} is not available in this run`,
      ),
    )
  }
  if (deps.mcp !== undefined && isMcpToolName(deps.mcp, name))
    return runMcpTool(deps.mcp, deps, name, rawArgs)
  switch (name) {
    case "read_file":
      return readFileTool(deps, rawArgs)
    case "write_file":
      return writeFileTool(deps, rawArgs)
    default:
      return runCommandTool(deps, rawArgs)
  }
}
