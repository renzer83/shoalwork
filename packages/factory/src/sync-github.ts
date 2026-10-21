// The GitHub side of the board (T-060). Everything here is pure: a delivery of the webhook becomes the
// decision the board applies. The delivery carries its own id, so the same event twice is the same event.
import { Schema } from "effect"

export type DeliveryType = "github.issues" | "github.pull_request" | "github.workflow_run"

// The label that says an issue may run.
export const READY_LABEL = "ready"

export const GithubDelivery = Schema.Struct({
  type: Schema.Literals(["github.issues", "github.pull_request", "github.workflow_run"]),
  deliveryId: Schema.String,
  repo: Schema.String,
  action: Schema.String,
  number: Schema.optional(Schema.Int),
  title: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  merged: Schema.optional(Schema.Boolean),
  conclusion: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
})
export type GithubDelivery = typeof GithubDelivery.Type

export type SyncDecision =
  | {
      readonly _tag: "create"
      readonly issueNumber: number
      readonly title: string
      readonly to: "backlog" | "ready"
    }
  | {
      readonly _tag: "review"
      readonly issueNumber: number
      readonly prNumber: number
      readonly branch: string | undefined
    }
  | { readonly _tag: "testing"; readonly branch: string | undefined }
  | { readonly _tag: "done"; readonly issueNumber: number; readonly prNumber: number }
  | { readonly _tag: "ignore" }

// The words a PR title uses to close an issue. Third-party text: the title is cut before the scan.
const CLOSE_WORDS: ReadonlySet<string> = new Set([
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
])

const MAX_TITLE = 500

// "Closes #12" (any case) names the issue a PR closes. The title is split into words and each word is
// compared, so a long title cannot make the scan slow.
export const issueNumberOf = (title: string): number | undefined => {
  const words = title.slice(0, MAX_TITLE).split(/\s+/)
  for (let index = 0; index < words.length - 1; index += 1) {
    const word = (words[index] ?? "").replace(/[^A-Za-z]/g, "").toLowerCase()
    if (!CLOSE_WORDS.has(word)) continue
    const number = (words[index + 1] ?? "").replace(/[^#0-9]/g, "")
    if (!number.startsWith("#")) continue
    const value = Number(number.slice(1))
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

// The repository of a project, as "owner/name" (the repo of a delivery).
// Handles https, http, ssh (git@github.com:owner/repo.git) and optional trailing .git or slashes.
export const repoOf = (url: string): string | undefined => {
  const clean = url
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
  const sshMatch = /^git@[^:]+:([^/]+)\/(.+)$/.exec(clean)
  if (sshMatch !== null) {
    const owner = sshMatch[1]?.toLowerCase()
    const name = sshMatch[2]?.toLowerCase()
    return owner && name ? `${owner}/${name}` : undefined
  }
  const parts = clean.split("/").filter((part) => part !== "" && part !== "https:" && part !== "http:")
  if (parts.length < 2) return undefined
  return `${parts[parts.length - 2]?.toLowerCase() ?? ""}/${parts[parts.length - 1]?.toLowerCase() ?? ""}`
}

// What a delivery means for the board. An issue opens a task (ready when the label says so), a PR puts the
// task of the issue it closes in review, a green CI puts the task in testing and a merged PR finishes it.
export const decideDelivery = (delivery: GithubDelivery): SyncDecision => {
  if (delivery.type === "github.issues") {
    if (delivery.number === undefined) return { _tag: "ignore" }
    const labels = delivery.labels ?? []
    const isReady = labels.some((label) => label.toLowerCase() === READY_LABEL)
    if (delivery.action === "opened") {
      return {
        _tag: "create",
        issueNumber: delivery.number,
        title: delivery.title ?? `issue ${delivery.number}`,
        to: isReady ? "ready" : "backlog",
      }
    }
    if ((delivery.action === "labeled" && isReady) || delivery.action === "reopened") {
      return {
        _tag: "create",
        issueNumber: delivery.number,
        title: delivery.title ?? `issue ${delivery.number}`,
        to: isReady ? "ready" : "backlog",
      }
    }
    return { _tag: "ignore" }
  }
  if (delivery.type === "github.pull_request") {
    const issueNumber = delivery.title === undefined ? undefined : issueNumberOf(delivery.title)
    if (issueNumber === undefined || delivery.number === undefined) return { _tag: "ignore" }
    if (delivery.action === "opened" || delivery.action === "reopened") {
      return {
        _tag: "review",
        issueNumber,
        prNumber: delivery.number,
        branch: delivery.headBranch,
      }
    }
    if (delivery.action === "closed" && delivery.merged === true) {
      return { _tag: "done", issueNumber, prNumber: delivery.number }
    }
    return { _tag: "ignore" }
  }
  if (delivery.action !== "completed" || delivery.conclusion !== "success") return { _tag: "ignore" }
  return { _tag: "testing", branch: delivery.headBranch }
}
