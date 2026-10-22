import { Option, Schema } from "effect"
import type { ExecutorView } from "../../../hooks/useExecutors.js"
import { defaultModelOf, executorName, type ModelInfo, modelsOf } from "./executor-catalog.js"

// The pure rules of the Configuração screen: what a preference is, how it is stored, how the rows read from the
// executors the core reports plus the choices made on this device. No component code in here.

export const ROUTE_RULES = ["always", "fallback", "last"] as const
export type RouteRule = (typeof ROUTE_RULES)[number]
export const ROUTE_PROFILES = ["quality", "balanced", "speed"] as const
export type RouteProfile = (typeof ROUTE_PROFILES)[number]

export const DEFAULT_MAX_TOKENS = 64_000
export const MIN_MAX_TOKENS = 1_000
export const MAX_MAX_TOKENS = 200_000

const RouteEntry = Schema.Struct({
  executor: Schema.String,
  // "" for an executor the catalog lists no model for.
  model: Schema.String,
  rule: Schema.Literals(ROUTE_RULES),
  profile: Schema.Literals(ROUTE_PROFILES),
})
export type RouteEntry = typeof RouteEntry.Type

const ExecutorPrefs = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  priority: Schema.optionalKey(Schema.Int),
  mainModel: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  maxTokens: Schema.optionalKey(Schema.Int),
})
export type ExecutorPrefs = typeof ExecutorPrefs.Type

// What "Salvar alterações" keeps on this device. Only choices: never a secret, never a path.
export const Preferences = Schema.Struct({
  version: Schema.Literal(1),
  defaultExecutor: Schema.optionalKey(Schema.String),
  executors: Schema.Record(Schema.String, ExecutorPrefs),
  routing: Schema.optionalKey(Schema.Array(RouteEntry)),
})
export type Preferences = typeof Preferences.Type

export const EMPTY_PREFERENCES: Preferences = { version: 1, executors: {} }

export const PREFERENCES_KEY = "shoalwork.settings.v1"

const PreferencesJson = Schema.fromJsonString(Preferences)

// A stored value that does not decode is the same as none: the defaults come back.
export const parsePreferences = (raw: string | null): Preferences =>
  raw === null
    ? EMPTY_PREFERENCES
    : Option.getOrElse(Schema.decodeUnknownOption(PreferencesJson)(raw), () => EMPTY_PREFERENCES)

export const serializePreferences = (preferences: Preferences): string =>
  Schema.encodeSync(PreferencesJson)(preferences)

export const samePreferences = (a: Preferences, b: Preferences): boolean =>
  serializePreferences(a) === serializePreferences(b)

// ---- the rows ----------------------------------------------------------------------------------------------------

// Conectado: the doctor says the CLI is fine. An executor the doctor does not check (an API adapter) is connected
// while its quota is not exhausted.
export const connectedOf = (executor: ExecutorView): boolean =>
  executor.cli === null ? executor.quota.available : executor.ok === true

export interface ExecutorSetting {
  readonly id: string
  readonly name: string
  readonly view: ExecutorView
  readonly connected: boolean
  readonly enabled: boolean
  readonly isDefault: boolean
  // 1-based, a permutation of 1..n over the executors.
  readonly priority: number
  readonly models: ReadonlyArray<ModelInfo>
  readonly enabledModels: ReadonlyArray<string>
  readonly mainModel: string | undefined
  readonly maxTokens: number
}

const prefsOf = (preferences: Preferences, id: string): ExecutorPrefs => preferences.executors[id] ?? {}

// The ids in priority order: the saved priority first, the order the core listed them for the rest.
const orderedIds = (
  executors: ReadonlyArray<ExecutorView>,
  preferences: Preferences,
): ReadonlyArray<string> =>
  executors
    .map((executor, index) => ({
      id: executor.id,
      rank: prefsOf(preferences, executor.id).priority ?? index + 1,
      index,
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id)

const enabledOf = (executor: ExecutorView, preferences: Preferences): boolean =>
  prefsOf(preferences, executor.id).enabled ?? connectedOf(executor)

// The default executor: the saved choice while it still exists, else the first one that is connected and enabled.
export const defaultExecutorOf = (
  executors: ReadonlyArray<ExecutorView>,
  preferences: Preferences,
): string | undefined => {
  const saved = preferences.defaultExecutor
  if (saved !== undefined && executors.some((executor) => executor.id === saved)) return saved
  const ids = orderedIds(executors, preferences)
  const usable = ids.find((id) => {
    const executor = executors.find((candidate) => candidate.id === id)
    return executor !== undefined && connectedOf(executor) && enabledOf(executor, preferences)
  })
  return usable ?? ids[0]
}

export const settingsOf = (
  executors: ReadonlyArray<ExecutorView>,
  preferences: Preferences,
): ReadonlyArray<ExecutorSetting> => {
  const ids = orderedIds(executors, preferences)
  const standard = defaultExecutorOf(executors, preferences)
  return ids.flatMap((id, position) => {
    const executor = executors.find((candidate) => candidate.id === id)
    if (executor === undefined) return []
    const prefs = prefsOf(preferences, id)
    const models = modelsOf(id)
    const known = (model: string): boolean => models.some((entry) => entry.id === model)
    const fallbackMain = defaultModelOf(id)?.id
    const main = prefs.mainModel !== undefined && known(prefs.mainModel) ? prefs.mainModel : fallbackMain
    const picked = (prefs.models ?? []).filter(known)
    const enabledModels = main === undefined ? [] : picked.includes(main) ? picked : [main, ...picked]
    return [
      {
        id,
        name: executorName(id),
        view: executor,
        connected: connectedOf(executor),
        enabled: enabledOf(executor, preferences),
        isDefault: id === standard,
        priority: position + 1,
        models,
        enabledModels,
        mainModel: main,
        maxTokens: prefs.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    ]
  })
}

// ---- edits: each returns the next preferences ---------------------------------------------------------------------

const patchExecutor = (preferences: Preferences, id: string, patch: ExecutorPrefs): Preferences => ({
  ...preferences,
  executors: { ...preferences.executors, [id]: { ...prefsOf(preferences, id), ...patch } },
})

export const setEnabled = (preferences: Preferences, id: string, enabled: boolean): Preferences =>
  patchExecutor(preferences, id, { enabled })

// The executor takes position `priority`; the others keep their relative order, so priorities stay 1..n.
export const setPriority = (
  executors: ReadonlyArray<ExecutorView>,
  preferences: Preferences,
  id: string,
  priority: number,
): Preferences => {
  const ids = orderedIds(executors, preferences).filter((candidate) => candidate !== id)
  const at = Math.min(Math.max(priority, 1), ids.length + 1) - 1
  ids.splice(at, 0, id)
  const next = ids.reduce<Preferences>(
    (current, candidate, index) => patchExecutor(current, candidate, { priority: index + 1 }),
    preferences,
  )
  return next
}

export const setDefault = (preferences: Preferences, id: string): Preferences => ({
  ...preferences,
  defaultExecutor: id,
})

// Turning "use as default" off hands the role to the next usable executor in priority order; with none, it stays.
export const clearDefault = (
  executors: ReadonlyArray<ExecutorView>,
  preferences: Preferences,
  id: string,
): Preferences => {
  const next = orderedIds(executors, preferences).find((candidate) => {
    const executor = executors.find((entry) => entry.id === candidate)
    return (
      candidate !== id && executor !== undefined && connectedOf(executor) && enabledOf(executor, preferences)
    )
  })
  return next === undefined ? preferences : setDefault(preferences, next)
}

export const setMainModel = (
  preferences: Preferences,
  setting: ExecutorSetting,
  model: string,
): Preferences =>
  patchExecutor(preferences, setting.id, {
    mainModel: model,
    models: setting.enabledModels.includes(model) ? setting.enabledModels : [...setting.enabledModels, model],
  })

// The last enabled model cannot be switched off; the main model moves to the first one that is left.
export const toggleModel = (
  preferences: Preferences,
  setting: ExecutorSetting,
  model: string,
): Preferences => {
  const has = setting.enabledModels.includes(model)
  if (has && setting.enabledModels.length <= 1) return preferences
  const models = has
    ? setting.enabledModels.filter((entry) => entry !== model)
    : [...setting.enabledModels, model]
  const mainModel = setting.mainModel === model && has ? models[0] : (setting.mainModel ?? model)
  return patchExecutor(preferences, setting.id, mainModel === undefined ? { models } : { models, mainModel })
}

export const setMaxTokens = (preferences: Preferences, id: string, maxTokens: number): Preferences =>
  patchExecutor(preferences, id, {
    maxTokens: Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(maxTokens))),
  })

// ---- the order the Guide answers in -------------------------------------------------------------------------------

const RULE_BY_POSITION: ReadonlyArray<RouteRule> = ["always", "fallback"]
const PROFILE_BY_POSITION: ReadonlyArray<RouteProfile> = ["quality", "balanced"]

// Until the order is edited it follows the priorities: every connected, enabled executor with its main model.
export const routingOf = (
  settings: ReadonlyArray<ExecutorSetting>,
  preferences: Preferences,
): ReadonlyArray<RouteEntry> => {
  const usable = new Set(settings.filter((setting) => setting.connected && setting.enabled).map((s) => s.id))
  if (preferences.routing !== undefined) {
    return preferences.routing.filter((entry) => usable.has(entry.executor))
  }
  return settings
    .filter((setting) => usable.has(setting.id))
    .map((setting, index) => ({
      executor: setting.id,
      model: setting.mainModel ?? "",
      rule: RULE_BY_POSITION[index] ?? "last",
      profile: PROFILE_BY_POSITION[index] ?? "speed",
    }))
}

export const withRouting = (preferences: Preferences, routing: ReadonlyArray<RouteEntry>): Preferences => ({
  ...preferences,
  routing,
})

// Moves one row; an index outside the list leaves it as it was.
export const moveEntry = <A>(entries: ReadonlyArray<A>, from: number, to: number): ReadonlyArray<A> => {
  if (from < 0 || from >= entries.length) return entries
  const target = Math.min(Math.max(to, 0), entries.length - 1)
  if (target === from) return entries
  const next = [...entries]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return entries
  next.splice(target, 0, moved)
  return next
}

export const patchEntry = (
  entries: ReadonlyArray<RouteEntry>,
  index: number,
  patch: Partial<Pick<RouteEntry, "rule" | "profile">>,
): ReadonlyArray<RouteEntry> =>
  entries.map((entry, position) => (position === index ? { ...entry, ...patch } : entry))

// ---- small formats ------------------------------------------------------------------------------------------------

// 64000 -> "64K"
export const tokensLabel = (tokens: number): string => `${Math.round(tokens / 1000)}K`

export const usdLabel = (value: number | undefined): string =>
  value === undefined ? "—" : `$${value.toFixed(3)}`
