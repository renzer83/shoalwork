import type { BeaconCostsQuery, CostReport, DailyCostList, SavingsReport } from "@shoalwork/api-client"
import { HttpError } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import type { PeriodKey } from "../components/beacon/beacon-model.js"

export type SummaryLoad<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly value: T }
  | { readonly kind: "failed"; readonly message: string }

export interface BeaconSummary {
  readonly savings: SummaryLoad<SavingsReport>
  readonly daily: SummaryLoad<DailyCostList>
  readonly costs: SummaryLoad<CostReport>
  readonly reload: () => void
}

const describeFailure = (error: unknown, baseUrl: string): string => {
  if (error instanceof HttpError) {
    return error.status === 0
      ? `Não foi possível falar com o core em ${baseUrl}`
      : `O core respondeu HTTP ${error.status}`
  }
  return "O core respondeu com um corpo inesperado"
}

// Savings, the daily cost and the cost by one dimension, for the period. One reload refreshes all three.
export function useBeaconSummary(period: PeriodKey, by: BeaconCostsQuery["by"]): BeaconSummary {
  const { client, config, ready } = useApi()
  const [savings, setSavings] = useState<SummaryLoad<SavingsReport>>({ kind: "loading" })
  const [daily, setDaily] = useState<SummaryLoad<DailyCostList>>({ kind: "loading" })
  const [costs, setCosts] = useState<SummaryLoad<CostReport>>({ kind: "loading" })
  const [generation, setGeneration] = useState(0)

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!ready) return
    let current = true
    setSavings({ kind: "loading" })
    setDaily({ kind: "loading" })
    setCosts({ kind: "loading" })
    const since = period
    const settle = <T>(run: Effect.Effect<T, unknown>, apply: (load: SummaryLoad<T>) => void): void => {
      void Effect.runPromise(Effect.result(run)).then((result) => {
        if (!current) return
        apply(
          result._tag === "Success"
            ? { kind: "loaded", value: result.success }
            : { kind: "failed", message: describeFailure(result.failure, config.baseUrl) },
        )
      })
    }
    settle(client.beacon.savings({ since }), setSavings)
    settle(client.beacon.daily({ since }), setDaily)
    settle(client.beacon.costs({ since, by }), setCosts)
    return () => {
      current = false
    }
  }, [client, config.baseUrl, ready, period, by, generation])

  return { savings, daily, costs, reload }
}
