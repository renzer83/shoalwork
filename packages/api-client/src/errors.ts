import { Data } from "effect"

// status 0 means the request never got an answer (network down, DNS, aborted); body then carries the reason.
export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number
  readonly body: unknown
}> {}
