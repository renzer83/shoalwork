import { ApprovalId } from "@shoalwork/contracts"
import { ApprovalDecisions } from "@shoalwork/currents"
import { ApprovalFlow } from "@shoalwork/lead"
import { Effect, Layer, Schema } from "effect"

// Binds the Telegram buttons to the Lead's approval flow: the same door the web and the CLI use.
export const ApprovalDecisionsLive: Layer.Layer<ApprovalDecisions, never, ApprovalFlow> = Layer.effect(
  ApprovalDecisions,
  Effect.gen(function* () {
    const flow = yield* ApprovalFlow
    return ApprovalDecisions.of({
      decide: (rawId, decision, by) =>
        Schema.decodeUnknownEffect(ApprovalId)(rawId).pipe(
          Effect.flatMap((id) => flow.decide(id, decision, by)),
          Effect.map((result) => (result._tag === "Resolved" ? ("resolved" as const) : ("already" as const))),
          Effect.catchTag("NotFound", () => Effect.succeed("unknown" as const)),
          Effect.catchCause(() => Effect.succeed("failed" as const)),
        ),
    })
  }),
)
