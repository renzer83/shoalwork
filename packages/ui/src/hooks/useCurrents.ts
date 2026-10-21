import { Effect } from "effect"
import { useCallback, useEffect, useState } from "react"
import { useApi } from "../api-context.js"
import {
  type ConnectorEntry,
  ConnectorList,
  UsageList,
  type UsageRow,
} from "../components/currents/currents-model.js"
import { failedStatus } from "./failure.js"

export type ConnectorsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<ConnectorEntry> }
  | { readonly kind: "failed"; readonly status: number }

// Every connector of the catalog (GET /connectors): native ones and MCP servers.
export function useConnectors(): { readonly load: ConnectorsLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<ConnectorsLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    void Effect.runPromise(Effect.result(client.get("/connectors", ConnectorList))).then((result) => {
      setLoad(
        result._tag === "Success"
          ? { kind: "loaded", rows: result.success.connectors }
          : { kind: "failed", status: failedStatus(result.failure) },
      )
    })
  }, [client])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}

export type UsageLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly rows: ReadonlyArray<UsageRow> }
  | { readonly kind: "failed"; readonly status: number }

// The recent calls of one connector (GET /connectors/:id/usage).
export function useConnectorUsage(id: string): { readonly load: UsageLoad; readonly reload: () => void } {
  const { client } = useApi()
  const [load, setLoad] = useState<UsageLoad>({ kind: "loading" })

  const reload = useCallback(() => {
    void Effect.runPromise(
      Effect.result(client.get(`/connectors/${encodeURIComponent(id)}/usage`, UsageList)),
    ).then((result) => {
      setLoad(
        result._tag === "Success"
          ? { kind: "loaded", rows: result.success.usage }
          : { kind: "failed", status: failedStatus(result.failure) },
      )
    })
  }, [client, id])

  useEffect(() => {
    reload()
  }, [reload])

  return { load, reload }
}
