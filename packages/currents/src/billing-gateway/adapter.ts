import {
  type BillingGatewayReader,
  Customer,
  type FinanceProvider,
  FinanceReadError,
  Invoice,
} from "@shoalwork/contracts"
import { Effect, Option, Redacted, Schema } from "effect"

// Generic HTTP reader for the billing-gateway and the control-panel: the contract of each is not known yet (ADR-022),
// so the paths and the field mapping come from config (config/connectors/*.yaml, parsed by the composition root and
// decoded here). Nothing in this module is specific to one contract.

// The JSONPath subset of the config: "$", ".key" and "[n]". No filters, no wildcards, no recursive descent.
export const SIMPLE_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$/
const PATH_TOKEN = /\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g

const SimplePath = Schema.String.check(Schema.isPattern(SIMPLE_PATH))
// Relative to the base URL, e.g. "/customers".
const EndpointPath = Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_/-]*$/))
export const BaseUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/))

// `items` locates the array in an answer (for a single object it is unused, "$" by convention). `fields` maps a
// neutral field name to the simple path that holds it in one item. A neutral field without a path is null.
export const ResourceMapping = Schema.Struct({
  path: EndpointPath,
  items: SimplePath,
  fields: Schema.Record(Schema.String, SimplePath),
})
export type ResourceMapping = typeof ResourceMapping.Type

export const BillingGatewayConfig = Schema.Struct({
  baseUrl: BaseUrl,
  mapping: Schema.Struct({
    customers: ResourceMapping,
    invoices: ResourceMapping,
  }),
})
export type BillingGatewayConfig = typeof BillingGatewayConfig.Type

export type ReadFailureReason = FinanceReadError["reason"]

export const failure = (
  provider: FinanceProvider,
  op: string,
  reason: ReadFailureReason,
  status: number,
): FinanceReadError => new FinanceReadError({ provider, op, reason, status })

// Reads a simple path. A missing key, a missing index or a non-container gives undefined.
export const select = (root: unknown, path: string): unknown => {
  let node: unknown = root
  for (const match of path.slice(1).matchAll(PATH_TOKEN)) {
    const [, key, index] = match
    if (typeof node !== "object" || node === null) return undefined
    if (key !== undefined) {
      if (Array.isArray(node) || !Object.hasOwn(node, key)) return undefined
      node = (node as Record<string, unknown>)[key]
    } else if (index !== undefined) {
      if (!Array.isArray(node)) return undefined
      node = (node as ReadonlyArray<unknown>)[Number(index)]
    }
  }
  return node
}

// One neutral object from one raw item. Every neutral name is present in the result: a missing path gives null, so
// a required field fails the schema and an optional one stays null.
export const mapFields = (
  item: unknown,
  fields: Readonly<Record<string, string>>,
  names: ReadonlyArray<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    names.map((name) => {
      const path = fields[name]
      const value = path === undefined ? undefined : select(item, path)
      return [name, value ?? null]
    }),
  )

const decodeItem = <A, I>(
  provider: FinanceProvider,
  op: string,
  raw: unknown,
  resource: ResourceMapping,
  names: ReadonlyArray<string>,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, FinanceReadError> =>
  Schema.decodeUnknownEffect(schema)(mapFields(raw, resource.fields, names)).pipe(
    Effect.mapError(() => failure(provider, op, "invalid_response", 0)),
  )

// A list answer: the array at `resource.items`, each item mapped and decoded. One bad item fails the whole read, so a
// Bot never reasons over a partial list it does not know is partial.
export const readRecords = <A, I>(
  provider: FinanceProvider,
  op: string,
  answer: unknown,
  resource: ResourceMapping,
  names: ReadonlyArray<string>,
  schema: Schema.Codec<A, I>,
): Effect.Effect<ReadonlyArray<A>, FinanceReadError> => {
  const items = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))(select(answer, resource.items))
  if (Option.isNone(items)) return Effect.fail(failure(provider, op, "invalid_response", 0))
  return Effect.forEach(items.value, (item) => decodeItem(provider, op, item, resource, names, schema))
}

// A single-object answer: the whole answer is the item.
export const readOne = <A, I>(
  provider: FinanceProvider,
  op: string,
  answer: unknown,
  resource: ResourceMapping,
  names: ReadonlyArray<string>,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, FinanceReadError> => decodeItem(provider, op, answer, resource, names, schema)

export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>

export interface HttpReaderOptions {
  readonly provider: FinanceProvider
  readonly baseUrl: string
  readonly token: Redacted.Redacted<string>
  // Injected by tests so that no request leaves the process.
  readonly fetch?: FetchLike | undefined
}

export interface HttpReader {
  // GET `path` under the base URL with `query`; the answer is parsed JSON, not yet mapped.
  readonly get: (
    op: string,
    path: string,
    query: Readonly<Record<string, string>>,
  ) => Effect.Effect<unknown, FinanceReadError>
}

// The token is sent as a bearer; it never appears in an error. The network error is dropped on purpose: its text may
// carry the URL.
export const httpReader = (options: HttpReaderOptions): HttpReader => {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const root = options.baseUrl.replace(/\/+$/, "")
  return {
    get: (op, path, query) => {
      const url = new URL(`${root}${path}`)
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
      return Effect.tryPromise({
        try: () =>
          doFetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${Redacted.value(options.token)}`,
              Accept: "application/json",
            },
          }),
        catch: () => failure(options.provider, op, "unreachable", 0),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.tryPromise({
                try: (): Promise<unknown> => response.json(),
                catch: () => failure(options.provider, op, "invalid_response", response.status),
              })
            : Effect.fail(failure(options.provider, op, "http", response.status)),
        ),
      )
    },
  }
}

export const unavailable = (provider: FinanceProvider, op: string): Effect.Effect<never, FinanceReadError> =>
  Effect.fail(failure(provider, op, "unavailable", 0))

const CUSTOMER_FIELDS = ["id", "email", "name", "createdAt", "defaultPaymentCard"] as const
const INVOICE_FIELDS = [
  "id",
  "customerId",
  "subscriptionId",
  "number",
  "status",
  "currency",
  "amountDue",
  "amountPaid",
  "createdAt",
  "hostedInvoiceUrl",
] as const

export interface BillingGatewayOptions {
  readonly config: BillingGatewayConfig
  readonly token: Redacted.Redacted<string>
  readonly fetch?: FetchLike | undefined
}

// Without options (no config, no token) the reader exists and every call fails as "unavailable". Building it never
// throws, so the boot does not depend on the gateway.
export const billingGatewayReader = (options?: BillingGatewayOptions): BillingGatewayReader => {
  if (options === undefined) {
    return {
      listCustomers: () => unavailable("billing-gateway", "billing-gateway.customers.list"),
      listInvoices: () => unavailable("billing-gateway", "billing-gateway.invoices.list"),
    }
  }
  const http = httpReader({
    provider: "billing-gateway",
    baseUrl: options.config.baseUrl,
    token: options.token,
    fetch: options.fetch,
  })
  const { customers, invoices } = options.config.mapping
  return {
    listCustomers: (query) =>
      Effect.gen(function* () {
        const op = "billing-gateway.customers.list"
        const answer = yield* http.get(
          op,
          customers.path,
          query.email === undefined ? {} : { email: query.email },
        )
        return yield* readRecords("billing-gateway", op, answer, customers, CUSTOMER_FIELDS, Customer)
      }),
    listInvoices: (query) =>
      Effect.gen(function* () {
        const op = "billing-gateway.invoices.list"
        const answer = yield* http.get(op, invoices.path, { customer: query.customerId })
        return yield* readRecords("billing-gateway", op, answer, invoices, INVOICE_FIELDS, Invoice)
      }),
  }
}
