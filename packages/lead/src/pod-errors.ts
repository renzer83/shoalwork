import { Data } from "effect"

// Typed failures of the Pod service (T-049). Ids are plain strings: they travel to the caller, not into a query.
export class PodMissing extends Data.TaggedError("PodMissing")<{ readonly podId: string }> {}
export class PodClosed extends Data.TaggedError("PodClosed")<{ readonly podId: string }> {}
export class PodExists extends Data.TaggedError("PodExists")<{ readonly podId: string }> {}
export class PodNotFinished extends Data.TaggedError("PodNotFinished")<{ readonly podId: string }> {}
export class PodTopicFailed extends Data.TaggedError("PodTopicFailed")<{ readonly cause: string }> {}
export class PodDeliveryFailed extends Data.TaggedError("PodDeliveryFailed")<{
  readonly taskId: string
  readonly cause: string
}> {}
export class PodMemoryFailed extends Data.TaggedError("PodMemoryFailed")<{
  readonly podId: string
  readonly cause: string
}> {}
