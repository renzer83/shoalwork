import type { ModelTier, TaskKind } from "@shoalwork/contracts"
import type { TierRouting } from "@shoalwork/executors"

// Tier of a task kind, from the routing table of config/model-tiers.yaml. The table covers every TaskKind.
export const tierFor = (kind: TaskKind, routing: TierRouting): ModelTier => routing[kind]
