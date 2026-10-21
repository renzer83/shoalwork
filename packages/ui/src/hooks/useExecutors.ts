import { HttpError } from "@shoalwork/api-client"
import { Effect, Schema } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import type { SummaryLoad } from "./useBeaconSummary.js"

// Mirrors GET /executors and POST /executors/:id/doctor of the core (services/core/src/http/routes/executors.ts).
const DoctorStatusWire = Schema.Literals(["ok", "drift", "missing", "auth_missing"])
const LoginStateWire = Schema.Literals(["logged_in", "logged_out", "unknown"])

export const ExecutorView = Schema.Struct({
  id: Schema.String,
  cli: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  pinnedVersion: Schema.NullOr(Schema.String),
  status: Schema.NullOr(DoctorStatusWire),
  ok: Schema.NullOr(Schema.Boolean),
  quota: Schema.Struct({
    executor: Schema.String,
    usedRatio: Schema.Number,
    available: Schema.Boolean,
    windowEndsAt: Schema.optionalKey(Schema.String),
  }),
  quality: Schema.Array(
    Schema.Struct({ kind: Schema.String, okRate: Schema.Number, n: Schema.Number, avgUsd: Schema.Number }),
  ),
  logins: Schema.Array(
    Schema.Struct({ botId: Schema.String, authMethod: Schema.NullOr(Schema.String), state: LoginStateWire }),
  ),
})
export type ExecutorView = typeof ExecutorView.Type
export const ExecutorList = Schema.Array(ExecutorView)

const DoctorOne = Schema.Struct({
  report: Schema.Struct({ executor: Schema.String, status: DoctorStatusWire }),
})

export interface ExecutorsState {
  readonly load: SummaryLoad<ReadonlyArray<ExecutorView>>
  readonly reload: () => void
  // The executor whose CLI is being re-probed, if any.
  readonly probing: string | null
  readonly probeFailure: string | null
  readonly reprobe: (id: string) => void
}

const describeFailure = (error: unknown, baseUrl: string): string => {
  if (error instanceof HttpError) {
    return error.status === 0
      ? `Não foi possível falar com o core em ${baseUrl}`
      : `O core respondeu HTTP ${error.status}`
  }
  return "O core respondeu com um corpo inesperado"
}

// The overview of every executor, and the re-probe of one CLI. A re-probe reloads the overview when it lands.
export function useExecutors(): ExecutorsState {
  const { client, config, ready } = useApi()
  const [load, setLoad] = useState<SummaryLoad<ReadonlyArray<ExecutorView>>>({ kind: "loading" })
  const [generation, setGeneration] = useState(0)
  const [probing, setProbing] = useState<string | null>(null)
  const [probeFailure, setProbeFailure] = useState<string | null>(null)

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!ready) return
    let current = true
    setLoad({ kind: "loading" })
    void Effect.runPromise(Effect.result(client.get("/executors", ExecutorList))).then((result) => {
      if (!current) return
      setLoad(
        result._tag === "Success"
          ? { kind: "loaded", value: result.success }
          : { kind: "failed", message: describeFailure(result.failure, config.baseUrl) },
      )
    })
    return () => {
      current = false
    }
  }, [client, config.baseUrl, ready, generation])

  const reprobe = useCallback(
    (id: string) => {
      setProbing(id)
      setProbeFailure(null)
      const path = `/executors/${encodeURIComponent(id)}/doctor`
      void Effect.runPromise(Effect.result(client.post(path, undefined, DoctorOne))).then((result) => {
        setProbing(null)
        if (result._tag === "Success") {
          reload()
          return
        }
        setProbeFailure(describeFailure(result.failure, config.baseUrl))
      })
    },
    [client, config.baseUrl, reload],
  )

  return { load, reload, probing, probeFailure, reprobe }
}
