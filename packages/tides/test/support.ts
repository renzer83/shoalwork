import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { type NewBot, NewBot as NewBotSchema, newTaskId, type TaskSpec } from "@shoalwork/contracts"
import type { makeDbLayer } from "@shoalwork/db"
import { Lead, type LeadShape } from "@shoalwork/lead"
import { Effect, Layer, Schema } from "effect"
import { TidesLive, type TidesOptions } from "../src/index.js"

export type Intake = Parameters<LeadShape["intake"]>[0]

// Records each intake and answers with a task spec. The Lead itself is not under test here.
export const fakeLead = (intakes: Array<Intake>): LeadShape => ({
  intake: (input) =>
    Effect.sync(() => {
      intakes.push(input)
      const spec: TaskSpec = { ...input, id: newTaskId(), tier: input.tier ?? "light" }
      return spec
    }),
  get: () => Effect.die("not used by tides"),
  runOnce: () => Effect.die("not used by tides"),
  runTask: () => Effect.die("not used by tides"),
  handoff: () => Effect.die("not used by tides"),
  abandon: () => Effect.void,
  startWorker: () => Effect.void,
})

export const NEW_BOT: NewBot = Schema.decodeUnknownSync(NewBotSchema)({
  name: "scout",
  role: "scout",
  instructions: "look around",
  kind: "auxiliary",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 600, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

// Tides on top of a database layer: Beacon, BotRegistry and a fake Lead provided underneath.
export const tidesEnv = (
  db: ReturnType<typeof makeDbLayer>,
  intakes: Array<Intake>,
  options: TidesOptions,
) => {
  const persistence = BeaconLive.pipe(Layer.provideMerge(db))
  const services = Layer.mergeAll(BotRegistryLive, Layer.succeed(Lead, fakeLead(intakes))).pipe(
    Layer.provideMerge(persistence),
  )
  return TidesLive(options).pipe(Layer.provideMerge(services))
}

export const TEMPLATE = {
  title: "Check the queue",
  prompt: "Look at the queue",
  kind: "research",
  tier: "light",
  budget: { tokens: 500, seconds: 300, usd: 0.5 },
} as const
