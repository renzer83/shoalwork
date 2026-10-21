import { type BotId, ConnectorId as ConnectorIdSchema, type Risk } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Connector } from "../connector.js"
import type { ToolGate } from "../notion/tools.js"
import { DriveError } from "./client.js"

// The tools read what the knowledge sync has already synced (drive_files). They never call Drive: a Bot cannot reach
// files outside the root folder through them.
export type DriveToolName = "drive.search" | "drive.file.get"
const MAX_RESULTS = 20
const DriveId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))

const SearchInput = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(200)),
})
const FileGetInput = Schema.Struct({ id: DriveId })

export interface DriveFileSummary {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly modifiedTime: string
  readonly importedAt: string
}

export type DriveToolResult = { readonly results: ReadonlyArray<DriveFileSummary> } | DriveFileSummary

export type DriveToolError = DriveError | SqlError

export interface DriveTool {
  readonly name: DriveToolName
  readonly risk: Risk
  readonly run: (input: unknown) => Effect.Effect<DriveToolResult, DriveToolError, SqlClient>
}

const FileRow = Schema.Struct({
  file_id: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  modified_time: Schema.String,
  imported_at: Schema.String,
})
const FileRows = Schema.Array(FileRow)
type FileRowType = typeof FileRow.Type

const summaryOf = (row: FileRowType): DriveFileSummary => ({
  id: row.file_id,
  name: row.name,
  mimeType: row.mime,
  modifiedTime: row.modified_time,
  importedAt: row.imported_at,
})

const decodeInput = <A, I>(
  op: DriveToolName,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, DriveError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => new DriveError({ op, message: `${op} input does not match its schema` })),
  )

const decodeRows = (
  op: DriveToolName,
  rows: unknown,
): Effect.Effect<ReadonlyArray<FileRowType>, DriveError> =>
  Schema.decodeUnknownEffect(FileRows)(rows).pipe(
    Effect.mapError(() => new DriveError({ op, message: `${op} rows do not match their schema` })),
  )

const searchTool: DriveTool = {
  name: "drive.search",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("drive.search", SearchInput, raw)
      const sql = yield* SqlClient
      const rows = yield* sql`SELECT file_id, name, mime, modified_time, imported_at FROM drive_files
        WHERE instr(lower(name), lower(${args.q})) > 0
        ORDER BY modified_time DESC LIMIT ${MAX_RESULTS}`
      const decoded = yield* decodeRows("drive.search", rows)
      return { results: decoded.map(summaryOf) }
    }),
}

const fileGetTool: DriveTool = {
  name: "drive.file.get",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("drive.file.get", FileGetInput, raw)
      const sql = yield* SqlClient
      const rows = yield* sql`SELECT file_id, name, mime, modified_time, imported_at FROM drive_files
        WHERE file_id = ${args.id}`
      const [row] = yield* decodeRows("drive.file.get", rows)
      if (row === undefined) {
        return yield* Effect.fail(new DriveError({ op: "drive.file.get", message: "file is not synced" }))
      }
      return summaryOf(row)
    }),
}

const TOOLS: Record<DriveToolName, DriveTool> = {
  "drive.search": searchTool,
  "drive.file.get": fileGetTool,
}

export const DRIVE_TOOLS: ReadonlyArray<DriveTool> = Object.values(TOOLS)

// Only "allow" runs the tool; "ask" and "deny" fail closed here and nothing is read. The call is not yet recorded as an
// event: drive.tool_called is not in the contracts registry (T-088 may not edit contracts; see the report).
export const callDriveTool = (
  gate: ToolGate,
  botId: BotId,
  name: DriveToolName,
  input: unknown,
): Effect.Effect<DriveToolResult, DriveToolError, SqlClient> =>
  Effect.gen(function* () {
    const decision = yield* gate.evaluate(botId, { tool: name, input })
    if (decision.effect !== "allow") {
      const message = decision.effect === "deny" ? `${name} denied by policy` : `${name} needs approval`
      return yield* Effect.fail(new DriveError({ op: name, message }))
    }
    return yield* TOOLS[name].run(input)
  })

export type DriveConnector = Connector<DriveTool, never>

export const driveConnector: DriveConnector = {
  id: Schema.decodeUnknownSync(ConnectorIdSchema)("drive"),
  permissions: DRIVE_TOOLS.map((tool) => ({ tool: tool.name, risk: tool.risk })),
  tools: DRIVE_TOOLS,
  triggers: [],
}
