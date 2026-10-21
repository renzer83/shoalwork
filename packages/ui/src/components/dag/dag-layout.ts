import { graphlib, layout } from "@dagrejs/dagre"

// Node box of the plan graph, in SVG units. dagre lays out the centres; the view draws from the top-left corner.
export const NODE_WIDTH = 180
export const NODE_HEIGHT = 56

export interface DagInput {
  readonly id: string
  // Steps this step waits for: each one is an edge into this node.
  readonly dependsOn: ReadonlyArray<string>
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface PlacedNode {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface PlacedEdge {
  readonly from: string
  readonly to: string
  readonly points: ReadonlyArray<Point>
}

export interface DagLayout {
  readonly nodes: ReadonlyArray<PlacedNode>
  readonly edges: ReadonlyArray<PlacedEdge>
  readonly width: number
  readonly height: number
}

interface NodeCentre {
  readonly x: number
  readonly y: number
}

interface EdgeRoute {
  readonly points?: ReadonlyArray<Point>
}

// Left to right by dependency. Pure and deterministic for the same input order; the core validates plans as acyclic.
export const layoutDag = (steps: ReadonlyArray<DagInput>): DagLayout => {
  const graph = new graphlib.Graph()
  graph.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 48 })
  graph.setDefaultEdgeLabel(() => ({}))
  const known = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    graph.setNode(step.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (known.has(dependency)) {
        graph.setEdge(dependency, step.id)
      }
    }
  }
  layout(graph)

  const nodes = steps.map((step): PlacedNode => {
    const centre: NodeCentre = graph.node(step.id)
    return { id: step.id, x: centre.x - NODE_WIDTH / 2, y: centre.y - NODE_HEIGHT / 2 }
  })
  const pairs: ReadonlyArray<{ readonly v: string; readonly w: string }> = graph.edges()
  const edges = pairs.map((edge): PlacedEdge => {
    const route: EdgeRoute = graph.edge(edge)
    return { from: edge.v, to: edge.w, points: route.points ?? [] }
  })
  const size = graph.graph()
  return { nodes, edges, width: size.width ?? 0, height: size.height ?? 0 }
}

// One cubic Bézier from the first point to the last, bending horizontally: a simple curve between two boxes.
export const edgePath = (points: ReadonlyArray<Point>): string => {
  const first = points[0]
  const last = points[points.length - 1]
  if (first === undefined || last === undefined) {
    return ""
  }
  const middle = (first.x + last.x) / 2
  return `M ${first.x} ${first.y} C ${middle} ${first.y}, ${middle} ${last.y}, ${last.x} ${last.y}`
}
