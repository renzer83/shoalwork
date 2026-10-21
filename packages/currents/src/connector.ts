import type { ConnectorId, Risk } from "@shoalwork/contracts"

// What every connector tool exposes to the permissions of a Bot: a name and the risk of the call.
export interface ConnectorToolShape {
  readonly name: string
  readonly risk: Risk
}

// A Connector is what a Bot may use of an external service: its tools, the risk of each, and the events it hears.
// Shared by the connectors of currents; each one fixes its own tool and trigger types.
export interface Connector<
  Tool extends ConnectorToolShape = ConnectorToolShape,
  Trigger extends string = string,
> {
  readonly id: ConnectorId
  readonly permissions: ReadonlyArray<{ readonly tool: string; readonly risk: Risk }>
  readonly tools: ReadonlyArray<Tool>
  readonly triggers: ReadonlyArray<Trigger>
}
