import type { Bot, TaskSpec } from "@shoalwork/contracts"
import type { McpInject } from "@shoalwork/executors"
import { Context, type Effect, type Redacted } from "effect"

// What the core resolved for one run of a Bot (T-185): the Bot's own MCP servers, as the CLI configs name them, and the
// secrets those servers need. The config files hold env names only; the values travel as Redacted to the Tank, which puts
// them in the env of the executor process and nowhere else (never argv, log or event).
export interface BotMcpGrant {
  readonly servers: ReadonlyArray<McpInject>
  readonly secretEnv: Readonly<Record<string, Redacted.Redacted<string>>>
}

export interface BotMcpShape {
  // Never fails: a server that cannot be given to the run (tools unknown, secret missing, not authorized) is left out and
  // the core records why. `undefined`: nothing to attach.
  readonly resolve: (bot: Bot, spec: Pick<TaskSpec, "id" | "botId">) => Effect.Effect<BotMcpGrant | undefined>
}

// Optional in the Lead's context, like the Reef: without it a run gets only the reef server.
export class BotMcp extends Context.Service<BotMcp, BotMcpShape>()("@shoalwork/BotMcp") {}
