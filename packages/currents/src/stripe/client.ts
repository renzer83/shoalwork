import { Context, Data, Effect, Redacted } from "effect"

// Stripe's REST API, read with fetch (no SDK). The API version is pinned on every request (06-research §7).
export const STRIPE_API_ROOT = "https://api.stripe.com/v1"
export const STRIPE_API_VERSION = "2026-09-30.endive"

// A failed call. The message names the operation and the HTTP status only: never the key, never the body.
// `status` is the HTTP status, 0 when no HTTP answer came or the answer did not match its schema.
export class StripeError extends Data.TaggedError("StripeError")<{
  readonly op: string
  readonly message: string
  readonly status: number
}> {}

// What the transport reports for a failed call.
export class StripeHttpError extends Data.TaggedError("StripeHttpError")<{
  readonly status: number
}> {}

// Only GET: this connector reads. Every Stripe tool is risk "read".
export interface StripeRequest {
  // Names the call in errors, e.g. "stripe.customers.list".
  readonly op: string
  // Relative to STRIPE_API_ROOT, e.g. "customers" or "invoices/in_123". Ids are checked by the caller.
  readonly path: string
  readonly query: Readonly<Record<string, string>>
}

// The only way out to the network. The fetch adapter below is the production one; tests pass a fake.
export interface StripeTransport {
  readonly send: (request: StripeRequest) => Effect.Effect<unknown, StripeHttpError>
}

export interface StripeShape {
  readonly request: (request: StripeRequest) => Effect.Effect<unknown, StripeError>
}

export class Stripe extends Context.Service<Stripe, StripeShape>()("@shoalwork/Stripe") {}

const failureMessage = (op: string, status: number): string => {
  if (status === 0) return `${op} failed`
  if (status === 429) return `${op} rate limited`
  return `${op} failed with HTTP ${status}`
}

export const makeStripe = (transport: StripeTransport): StripeShape => ({
  request: (request) =>
    transport.send(request).pipe(
      Effect.mapError(
        (error) =>
          new StripeError({
            op: request.op,
            message: failureMessage(request.op, error.status),
            status: error.status,
          }),
      ),
    ),
})

export type StripeFetch = (url: URL, init: RequestInit) => Promise<Response>

export interface StripeTransportOptions {
  // Injected by tests so that no request leaves the process.
  readonly fetch?: StripeFetch | undefined
}

// Production transport: GET on the REST API with the restricted key as bearer token and the pinned version header.
export const stripeTransport = (
  apiKey: Redacted.Redacted<string>,
  options: StripeTransportOptions = {},
): StripeTransport => {
  const doFetch: StripeFetch = options.fetch ?? ((url, init) => fetch(url, init))
  return {
    send: (request) => {
      const url = new URL(`${STRIPE_API_ROOT}/${request.path}`)
      for (const [name, value] of Object.entries(request.query)) url.searchParams.set(name, value)
      // The network error is dropped on purpose: its text may carry the URL or headers.
      return Effect.tryPromise({
        try: () =>
          doFetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${Redacted.value(apiKey)}`,
              "Stripe-Version": STRIPE_API_VERSION,
              Accept: "application/json",
            },
          }),
        catch: () => new StripeHttpError({ status: 0 }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.tryPromise({
                try: (): Promise<unknown> => response.json(),
                catch: () => new StripeHttpError({ status: 0 }),
              })
            : Effect.fail(new StripeHttpError({ status: response.status })),
        ),
      )
    },
  }
}
