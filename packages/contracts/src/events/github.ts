import { Schema } from "effect"

// GitHub events (T-045): minimal fields only. The webhook cuts and redacts titles and branch names before they get
// here, and no issue or PR body is ever stored. Third-party text is data (R14): nothing here is an instruction.
// botAuthored marks the Bot's own work (a PR or push from a Bot branch) so a Tide can filter it out.
export const GithubCommonFields = {
  deliveryId: Schema.String,
  repo: Schema.String,
  action: Schema.String,
  sender: Schema.String,
  url: Schema.String,
  botAuthored: Schema.Boolean,
}

export const GithubIssuesPayload = Schema.Struct({
  ...GithubCommonFields,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.optional(Schema.String),
  // Label names, cleaned. The board reads them to know if an issue is ready to run (T-060).
  labels: Schema.optional(Schema.Array(Schema.String)),
})

export const GithubPullRequestPayload = Schema.Struct({
  ...GithubCommonFields,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  // True when the PR was merged (not only closed). The board finishes a task on a merge (T-060).
  merged: Schema.optional(Schema.Boolean),
})

export const GithubWorkflowRunPayload = Schema.Struct({
  ...GithubCommonFields,
  title: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
})

export const GithubCheckSuitePayload = Schema.Struct({
  ...GithubCommonFields,
  headBranch: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
})

export const GithubPushPayload = Schema.Struct({
  ...GithubCommonFields,
  ref: Schema.String,
})

// A change to a GitHub App installation (T-084), appended in the same transaction as its github_installations row.
// Only ids, the account login and repo names: no token, no key, no delivery body. `repos` is the list an
// installation delivery set; `added` / `removed` are the names an installation_repositories delivery changed.
export const GithubInstallationPayload = Schema.Struct({
  deliveryId: Schema.String,
  installationId: Schema.Int,
  account: Schema.String,
  action: Schema.String,
  repos: Schema.optional(Schema.Array(Schema.String)),
  added: Schema.optional(Schema.Array(Schema.String)),
  removed: Schema.optional(Schema.Array(Schema.String)),
})
