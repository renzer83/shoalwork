import { randomUUID } from "node:crypto"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { type BotId, type PolicyDecision, type Risk, streamIds, type ToolCall } from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import { Notion, NotionError } from "./client.js"
import { CreatedPageWire, chunkText, decodeWire, PageWire, ResultsWire, SearchWire, titleOf } from "./wire.js"

// Notion's limits: a rich text item holds at most 2000 units, a request at most 100 blocks.
export const RICH_TEXT_MAX = 2000
export const BLOCKS_PER_REQUEST = 100
const SEARCH_PAGE_SIZE = 10

export type NotionToolName = "notion.search" | "notion.page.get" | "notion.page.create" | "notion.page.append"

// Ids come from the caller and go into a path: only the characters Notion ids have.
const NotionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/))

const RichText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.Struct({
    content: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(RICH_TEXT_MAX)),
  }),
})
export const ParagraphBlock = Schema.Struct({
  object: Schema.Literal("block"),
  type: Schema.Literal("paragraph"),
  paragraph: Schema.Struct({
    rich_text: Schema.Array(RichText)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(BLOCKS_PER_REQUEST)),
  }),
})
export type ParagraphBlock = typeof ParagraphBlock.Type

const Blocks = Schema.Array(ParagraphBlock).check(Schema.isMaxLength(BLOCKS_PER_REQUEST))
const SearchInput = Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(200)) })
const PageGetInput = Schema.Struct({ id: NotionId })
const PageCreateInput = Schema.Struct({
  dataSourceId: NotionId,
  // Property values depend on the data source's schema; Notion validates them, the connector only bounds the call.
  properties: Schema.Record(Schema.String, Schema.Unknown),
  children: Blocks,
})
const PageAppendInput = Schema.Struct({
  id: NotionId,
  blocks: Blocks.check(Schema.isMinLength(1)),
})

export interface NotionPageSummary {
  readonly id: string
  readonly url: string
  readonly lastEditedTime: string
  readonly title: string
}

export type NotionToolResult =
  | {
      readonly results: ReadonlyArray<{
        readonly id: string
        readonly object: string
        readonly title: string
      }>
    }
  | NotionPageSummary
  | { readonly id: string; readonly url: string }
  | { readonly appended: number }

export interface NotionTool {
  readonly name: NotionToolName
  readonly risk: Risk
  readonly run: (input: unknown) => Effect.Effect<NotionToolResult, NotionError, Notion>
}

const decodeInput = <A, I>(
  op: NotionToolName,
  schema: Schema.Codec<A, I>,
  raw: unknown,
): Effect.Effect<A, NotionError> =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => new NotionError({ op, message: `${op} input does not match its schema` })),
  )

const summaryOf = (page: PageWire): NotionPageSummary => ({
  id: page.id,
  url: page.url,
  lastEditedTime: page.last_edited_time,
  title: titleOf(page),
})

const searchTool: NotionTool = {
  name: "notion.search",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("notion.search", SearchInput, raw)
      const notion = yield* Notion
      const answer = yield* notion.request({
        op: "notion.search",
        method: "post",
        path: "search",
        body: { query: args.query, page_size: SEARCH_PAGE_SIZE },
      })
      const found = yield* decodeWire("notion.search", SearchWire, answer)
      return {
        results: found.results.map((item) => ({ id: item.id, object: item.object, title: titleOf(item) })),
      }
    }),
}

const pageGetTool: NotionTool = {
  name: "notion.page.get",
  risk: "read",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("notion.page.get", PageGetInput, raw)
      const notion = yield* Notion
      const answer = yield* notion.request({ op: "notion.page.get", method: "get", path: `pages/${args.id}` })
      return summaryOf(yield* decodeWire("notion.page.get", PageWire, answer))
    }),
}

const pageCreateTool: NotionTool = {
  name: "notion.page.create",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("notion.page.create", PageCreateInput, raw)
      const notion = yield* Notion
      const answer = yield* notion.request({
        op: "notion.page.create",
        method: "post",
        path: "pages",
        body: {
          parent: { type: "data_source_id", data_source_id: args.dataSourceId },
          properties: args.properties,
          children: args.children,
        },
      })
      const created = yield* decodeWire("notion.page.create", CreatedPageWire, answer)
      return { id: created.id, url: created.url }
    }),
}

const pageAppendTool: NotionTool = {
  name: "notion.page.append",
  risk: "external",
  run: (raw) =>
    Effect.gen(function* () {
      const args = yield* decodeInput("notion.page.append", PageAppendInput, raw)
      const notion = yield* Notion
      const answer = yield* notion.request({
        op: "notion.page.append",
        method: "patch",
        path: `blocks/${args.id}/children`,
        body: { children: args.blocks },
      })
      const appended = yield* decodeWire("notion.page.append", ResultsWire, answer)
      return { appended: appended.results.length }
    }),
}

const TOOLS: Record<NotionToolName, NotionTool> = {
  "notion.search": searchTool,
  "notion.page.get": pageGetTool,
  "notion.page.create": pageCreateTool,
  "notion.page.append": pageAppendTool,
}

export const NOTION_TOOLS: ReadonlyArray<NotionTool> = Object.values(TOOLS)

// The policy's verdict on a call (02-architecture §7). Structural, so the composition passes the Policy service as it
// is. Only "allow" runs the tool: "ask" and "deny" fail closed here, nothing is sent.
export interface ToolGate {
  readonly evaluate: (botId: BotId, call: ToolCall) => Effect.Effect<PolicyDecision>
}

const TargetRef = Schema.Struct({
  id: Schema.optionalKey(NotionId),
  dataSourceId: Schema.optionalKey(NotionId),
})
// What a call names in Notion: a page (get, append) or a data source (create). Only these ids are ever recorded.
interface CallTarget {
  readonly pageId: string | undefined
  readonly dataSourceId: string | undefined
}
const targetOf = (input: unknown): CallTarget => {
  const ref = Schema.decodeUnknownOption(TargetRef)(input)
  return Option.isSome(ref)
    ? { pageId: ref.value.id, dataSourceId: ref.value.dataSourceId }
    : { pageId: undefined, dataSourceId: undefined }
}

// One notion.tool_called event per call, allowed or not (R12). The event follows the call's effect: a Notion write is
// an HTTP call and cannot share a SQLite transaction, so a failed write is recorded as ok false. A failed append is a
// defect: the call's record is part of the call.
const recordToolCall = (
  beacon: BeaconShape,
  botId: BotId,
  tool: NotionToolName,
  decision: PolicyDecision["effect"],
  ok: boolean,
  target: CallTarget,
): Effect.Effect<void> =>
  beacon
    .append({
      streamId: streamIds.bot(botId),
      type: "notion.tool_called",
      payload: {
        tool,
        botId,
        decision,
        ok,
        ...(target.pageId === undefined ? {} : { pageId: target.pageId }),
        ...(target.dataSourceId === undefined ? {} : { dataSourceId: target.dataSourceId }),
      },
      actor: `bot:${botId}`,
      correlationId: randomUUID(),
    })
    .pipe(Effect.asVoid, Effect.orDie)

export const callNotionTool = (
  gate: ToolGate,
  botId: BotId,
  name: NotionToolName,
  input: unknown,
): Effect.Effect<NotionToolResult, NotionError, Notion | Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const target = targetOf(input)
    const decision = yield* gate.evaluate(botId, { tool: name, input })
    if (decision.effect !== "allow") {
      yield* recordToolCall(beacon, botId, name, decision.effect, false, target)
      const message = decision.effect === "deny" ? `${name} denied by policy` : `${name} needs approval`
      return yield* Effect.fail(new NotionError({ op: name, message }))
    }
    return yield* TOOLS[name].run(input).pipe(
      Effect.tap(() => recordToolCall(beacon, botId, name, "allow", true, target)),
      Effect.tapError(() => recordToolCall(beacon, botId, name, "allow", false, target)),
    )
  })

// Splits a brief into pieces of at most RICH_TEXT_MAX units, packed by line; a longer line is cut inside.
export const splitBrief = (text: string): Array<string> => {
  const pieces: Array<string> = []
  let current = ""
  for (const line of text.split("\n")) {
    if (line.length > RICH_TEXT_MAX) {
      if (current !== "") pieces.push(current)
      current = ""
      pieces.push(...chunkText(line, RICH_TEXT_MAX))
      continue
    }
    const candidate = current === "" ? line : `${current}\n${line}`
    if (candidate.length > RICH_TEXT_MAX) {
      pieces.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current !== "") pieces.push(current)
  return pieces
}

// One paragraph block per piece. The caller sends at most BLOCKS_PER_REQUEST blocks per call.
export const briefToBlocks = (text: string): Array<ParagraphBlock> =>
  splitBrief(text).map(
    (content): ParagraphBlock => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content } }] },
    }),
  )
