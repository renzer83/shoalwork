import type { StepState } from "@shoalwork/api-client"
import { useMemo } from "react"
import { ScrollView } from "react-native"
import { Svg } from "react-native-svg"
import { DagEdge } from "./DagEdge.js"
import { DagNode } from "./DagNode.js"
import { edgePath, layoutDag } from "./dag-layout.js"

export interface DagStep {
  readonly id: string
  readonly title: string
  readonly state: StepState
  readonly costUsd: number
  readonly dependsOn: ReadonlyArray<string>
}

export interface DagViewProps {
  readonly steps: ReadonlyArray<DagStep>
}

// The plan as a graph: one box per step (coloured by its state), one curve per dependency. Scrolls both ways.
export function DagView({ steps }: DagViewProps) {
  const layout = useMemo(() => layoutDag(steps), [steps])
  const byId = useMemo(() => new Map(steps.map((step) => [step.id, step] as const)), [steps])
  return (
    <ScrollView horizontal contentContainerStyle={{ padding: 8 }}>
      <ScrollView>
        <Svg width={layout.width} height={layout.height}>
          {layout.edges.map((edge) => (
            <DagEdge key={`${edge.from}>${edge.to}`} d={edgePath(edge.points)} />
          ))}
          {layout.nodes.map((node) => {
            const step = byId.get(node.id)
            if (step === undefined) return null
            return (
              <DagNode
                key={node.id}
                x={node.x}
                y={node.y}
                title={step.title}
                state={step.state}
                costUsd={step.costUsd}
              />
            )
          })}
        </Svg>
      </ScrollView>
    </ScrollView>
  )
}
