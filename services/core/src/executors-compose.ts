import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import { Beacon } from "@shoalwork/beacon"
import { type ConfigError, ExecutorSpawnError, streamIds } from "@shoalwork/contracts"
import {
  CHAT_ID,
  CODEX_ID,
  DoctorConfigLive,
  type DoctorReport,
  defaultChatMapTier,
  doctor,
  doctorBin,
  type Executor,
  type ExecutorRegistry,
  type ExecutorsConfigDeps,
  loadExecutorsConfig,
  makeClaudeCodeChat,
  makeRegistry,
  type OpenAICompatPolicy,
  type QuotaConfig,
  QuotaStore,
  type QuotaStoreShape,
  type TierConfig,
  tierMappingFrom,
  WINDOW_MS,
} from "@shoalwork/executors"
import { Policy } from "@shoalwork/policy"
import { Context, Effect, Layer, Option, Ref, Result, Stream } from "effect"
import { acpExecutors } from "./acp-executors.js"
import type { AppConfigShape } from "./config.js"
import { hostEnvSnapshot, resolveRepoPath } from "./config.js"
import { codexModelsFrom } from "./model-tiers.js"

// `which` without a shell: walks PATH and checks the execute bit. A lookup failure just means "not installed".
const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const findOnPath = (name: string, pathValue: string | undefined): boolean =>
  (pathValue ?? "")
    .split(":")
    .filter((dir) => dir !== "")
    .some((dir) => isExecutable(join(dir, name)))

// The legacy counters (the acp adapters, and codex when it has no store) take a window and a soft limit. Both come
// from config/quotas.yaml, the one source of quota numbers: the codex 5h window. With no such window there is no
// limit to count against.
export const legacyLimitOf = (
  quotaConfig: QuotaConfig,
): { readonly windowSeconds: number; readonly softLimitTokens: number } => {
  const fiveHour = quotaConfig.executors[CODEX_ID]?.windows.find((window) => window.kind === "5h")
  return {
    windowSeconds: WINDOW_MS["5h"] / 1000,
    softLimitTokens: fiveHour?.soft_tokens ?? Number.MAX_SAFE_INTEGER,
  }
}

// What the executors are built from. `quota` is the shared store; the chat-only callers pass undefined because they
// need the ids alone. `executorsConfigPath` is config/executors.yaml (EXECUTORS_CONFIG_PATH).
export type ExecutorsInput = {
  readonly config: Pick<AppConfigShape, "permissionBridge" | "codexModel"> & {
    readonly executorsConfigPath?: string
  }
  readonly tiers: TierConfig
  readonly quotaConfig: QuotaConfig
  readonly quota: QuotaStoreShape | undefined
  readonly onPath?: (bin: string) => boolean
}

// Callers that do not set the path (the tests) read the shipped file, anchored to the repo root like the config.
const DEFAULT_EXECUTORS_CONFIG = resolveRepoPath("config/executors.yaml")
const configPathOf = (input: ExecutorsInput): string =>
  input.config.executorsConfigPath ?? DEFAULT_EXECUTORS_CONFIG

const onPathOf = (input: ExecutorsInput): ((bin: string) => boolean) =>
  input.onPath ?? ((bin: string) => findOnPath(bin, hostEnvSnapshot().PATH))

// The Policy of the Bot for tool calls of the openai-compat instances: the same rule as the ACP adapters' (acp-executors.ts),
// stated here so that module keeps only the ACP wiring. Without the service the call is asked, never pre-approved.
const botPolicy: OpenAICompatPolicy = (botId, call, context) =>
  Effect.serviceOption(Policy).pipe(
    Effect.flatMap((policy) =>
      Option.isSome(policy)
        ? policy.value.evaluate(botId, call, context)
        : Effect.succeed({ effect: "ask", risk: "external" } as const),
    ),
  )

// The inputs of the instances of config/executors.yaml. The env is the core's; the loader reads only its allowlist.
const depsOf = (input: ExecutorsInput): ExecutorsConfigDeps => {
  const legacy = legacyLimitOf(input.quotaConfig)
  return {
    env: hostEnvSnapshot(),
    onPath: onPathOf(input),
    tiers: input.tiers,
    quota: input.quota,
    permissionBridge: input.config.permissionBridge,
    codexModels: codexModelsFrom(input.tiers, input.config.codexModel),
    codexCounter: { windowSeconds: legacy.windowSeconds, softLimitTokens: legacy.softLimitTokens },
    policy: botPolicy,
  }
}

// Executors the code composes itself: the conversation's chat adapter (never a Bot's) and the ACP agents, which are
// registered only when their binary is on this host (ADR-011: no API keys).
const composedExecutors = (input: ExecutorsInput): ReadonlyArray<Executor> => {
  const legacy = legacyLimitOf(input.quotaConfig)
  return [
    makeClaudeCodeChat({ mapTier: tierMappingFrom(input.tiers, CHAT_ID, defaultChatMapTier) }),
    ...acpExecutors({
      onPath: onPathOf(input),
      quotaWindowSeconds: legacy.windowSeconds,
      quotaSoftLimitTokens: legacy.softLimitTokens,
    }),
  ]
}

// Every executor id this host has, as the boot sees them. The instances of executors.yaml are read synchronously here,
// so the id list the Bot factory gets is the same as the registry's. A broken file yields only the composed ids:
// RegistryFromConfig then fails the boot with the ConfigError, which is the one place that reports it.
export const executorsFor = (input: ExecutorsInput): ReadonlyArray<Executor> => {
  const configured = Effect.runSync(Effect.result(loadExecutorsConfig(configPathOf(input), depsOf(input))))
  return [...(Result.isSuccess(configured) ? configured.success : []), ...composedExecutors(input)]
}

// The env the doctor's CLI calls get (ADR-011): these names only, never the core's env. Each is one a CLI reads its home
// or its login from; a name that is not set is left out.
export const DOCTOR_ENV: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_API_KEY",
  "GEMINI_CLI_HOME",
  "XDG_DATA_HOME",
]

const doctorEnvOf = (env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> => {
  const picked: Record<string, string> = {}
  for (const name of DOCTOR_ENV) {
    const value = env[name]
    if (value !== undefined) picked[name] = value
  }
  return picked
}

// config/executor-versions.yaml of this checkout, anchored to the repo root like the other config files.
const DEFAULT_EXECUTOR_VERSIONS = resolveRepoPath("config/executor-versions.yaml")

// The doctor's reports for this host, read at call time. A broken pins file is a ConfigError.
export type DoctorRun = () => Effect.Effect<ReadonlyArray<DoctorReport>, ConfigError>

export const hostDoctor: DoctorRun = () =>
  doctor().pipe(Effect.provide(DoctorConfigLive(DEFAULT_EXECUTOR_VERSIONS, doctorEnvOf(hostEnvSnapshot()))))

// One CLI's report, probed alone (POST /executors/:id/doctor, T-117). The same env allowlist as hostDoctor.
export const hostDoctorBin = (bin: string) =>
  doctorBin(bin).pipe(
    Effect.provide(DoctorConfigLive(DEFAULT_EXECUTOR_VERSIONS, doctorEnvOf(hostEnvSnapshot()))),
  )

// The doctor's verdict as the registry reads it. Empty until the boot's probes finish: until then every instance runs
// as before. A service, so the registry and the probes share the one reference.
export class DoctorGate extends Context.Service<DoctorGate, Ref.Ref<ReadonlyArray<DoctorReport>>>()(
  "@shoalwork/DoctorGate",
) {}
const DoctorGateLive = Layer.effect(DoctorGate, Ref.make<ReadonlyArray<DoctorReport>>([]))

// The CLI an executor runs on. Every instance of one binary shares that CLI's status: claude-code, claude-code@zai and
// claude-code@ollama all run `claude`. Undefined: the doctor does not check that executor's CLI.
export const doctorBinOf = (id: string): string | undefined => {
  if (id === "claude-code" || id.startsWith("claude-code@")) return "claude"
  if (id === "codex" || id.startsWith("codex@")) return "codex"
  if (id === "acp-gemini") return "gemini"
  if (id === "acp-opencode") return "opencode"
  return undefined
}

// Why an executor cannot run, from the verdict: its CLI is missing or not logged in. Undefined: it may run.
const blockedBy = (id: string, reports: ReadonlyArray<DoctorReport>): string | undefined => {
  const bin = doctorBinOf(id)
  const report = reports.find(
    (candidate) =>
      candidate.bin === bin && (candidate.status === "missing" || candidate.status === "auth_missing"),
  )
  if (report === undefined) return undefined
  return `doctor: ${report.status}${report.detail === undefined ? "" : ` (${report.detail})`}`
}

type RunStream = ReturnType<Executor["run"]>

// The gate is read at each call: the verdict applies as soon as the boot's probes finish. A blocked executor is
// unavailable in quota (the choice skips it) and refuses a run at once, as gated() does for a missing env.
const gatedBy = (executor: Executor, gate: Ref.Ref<ReadonlyArray<DoctorReport>>): Executor => ({
  id: executor.id,
  mapTier: executor.mapTier,
  quota: () =>
    Effect.flatMap(Ref.get(gate), (reports) =>
      blockedBy(executor.id, reports) === undefined
        ? executor.quota()
        : Effect.map(executor.quota(), (status) => ({ ...status, available: false })),
    ),
  run: (task, ctx) =>
    Stream.unwrap(
      Effect.map(Ref.get(gate), (reports): RunStream => {
        const reason = blockedBy(executor.id, reports)
        return reason === undefined
          ? executor.run(task, ctx)
          : Stream.fail(new ExecutorSpawnError({ executor: executor.id, cause: reason }))
      }),
    ),
})

const DOCTOR_TAG: Readonly<Record<"drift" | "missing" | "auth_missing", string>> = {
  drift: "ExecutorDrift",
  missing: "ExecutorMissing",
  auth_missing: "ExecutorAuthMissing",
}

// The boot's probes, in a fiber of the layer's scope (so a shutdown stops them). The verdict goes to the gate first;
// then each non-ok CLI becomes error.raised (where "doctor"), once per boot. A pins file that cannot be read is recorded
// the same way (tag ConfigError). The message carries versions and the CLI's own short reason, never its output.
const probeOnBoot = (doctorRun: DoctorRun): Effect.Effect<void, never, Beacon | DoctorGate> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const gate = yield* DoctorGate
    const note = (tag: string, message: string) =>
      beacon
        .append({
          streamId: streamIds.system,
          type: "error.raised",
          payload: { where: "doctor", tag, message },
          actor: "system:doctor",
          correlationId: "doctor",
        })
        .pipe(Effect.catch((error) => Effect.logError("doctor: event not recorded", error)))
    const outcome = yield* Effect.result(doctorRun())
    if (Result.isFailure(outcome)) {
      yield* note("ConfigError", outcome.failure.message)
      return
    }
    yield* Ref.set(gate, outcome.success)
    for (const report of outcome.success) {
      if (report.status === "ok") continue
      yield* note(DOCTOR_TAG[report.status], `${report.executor}: ${report.detail ?? report.status}`)
    }
  })

// The registry of this host. It needs the shared quota store, so it is built on top of QuotaStore: the adapters and the
// quota routes read the same instance. A broken executors.yaml fails the layer with a ConfigError naming the file.
// The doctor runs once per boot in the background: the boot does not wait for the CLIs (a slow CLI would hold the whole
// core up). Drift, missing and not-logged-in CLIs are recorded as error.raised; missing and not-logged-in instances stop
// being chosen once the verdict is in. Nothing here fails the boot.
export const RegistryFromConfig = (
  config: ExecutorsInput["config"],
  tiers: TierConfig,
  quotaConfig: QuotaConfig,
  doctorRun: DoctorRun = hostDoctor,
): Layer.Layer<ExecutorRegistry | DoctorGate, ConfigError, QuotaStore | Beacon> => {
  const registry = Layer.unwrap(
    Effect.gen(function* () {
      const quota = yield* QuotaStore
      const gate = yield* DoctorGate
      const input: ExecutorsInput = { config, tiers, quotaConfig, quota }
      const configured = yield* loadExecutorsConfig(configPathOf(input), depsOf(input))
      return makeRegistry(
        [...configured, ...composedExecutors(input)].map((executor) => gatedBy(executor, gate)),
      )
    }),
  )
  const probes = Layer.effectDiscard(Effect.forkScoped(probeOnBoot(doctorRun)))
  return Layer.mergeAll(registry, probes).pipe(Layer.provideMerge(DoctorGateLive))
}
