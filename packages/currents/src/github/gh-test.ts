import { Effect, Layer } from "effect"
import { GhClient, type GhClientShape } from "./gh.js"

export interface GhCall {
  readonly method: keyof GhClientShape
  readonly args: ReadonlyArray<unknown>
}

export interface GhTestReplies {
  readonly issue?: { readonly title: string; readonly body: string; readonly labels: ReadonlyArray<string> }
  readonly prCreate?: { readonly url: string; readonly number: number }
  readonly prChecks?: "pass" | "fail" | "pending"
  readonly pr?: { readonly state: string; readonly mergeable: string; readonly headRef: string }
}

// Records every call and answers from the replies (defaults: a PR number 1 in the sandbox repo). Never runs gh.
export const GhClientTest = (replies: GhTestReplies = {}) => {
  const calls: Array<GhCall> = []
  const record = (method: keyof GhClientShape, args: ReadonlyArray<unknown>) => calls.push({ method, args })
  const shape: GhClientShape = {
    issueView: (repo, n) => {
      record("issueView", [repo, n])
      return Effect.succeed(replies.issue ?? { title: "Issue", body: "", labels: [] })
    },
    prCreate: (ctx, o, auth) => {
      // The auth is recorded only when the caller gave one, so calls without it record exactly as before.
      record("prCreate", auth === undefined ? [ctx.cwd, o] : [ctx.cwd, o, auth])
      return Effect.succeed(
        replies.prCreate ?? { url: "https://github.com/renzer83/shoalwork-sandbox/pull/1", number: 1 },
      )
    },
    prChecks: (repo, n, o) => {
      record("prChecks", [repo, n, o])
      return Effect.succeed(replies.prChecks ?? "pass")
    },
    prMerge: (repo, n, o) => {
      record("prMerge", [repo, n, o])
      return Effect.void
    },
    prView: (repo, n) => {
      record("prView", [repo, n])
      return Effect.succeed(
        replies.pr ?? { state: "OPEN", mergeable: "MERGEABLE", headRef: "bot/dev/step_1" },
      )
    },
  }
  return { calls, shape, layer: Layer.succeed(GhClient, shape) }
}
