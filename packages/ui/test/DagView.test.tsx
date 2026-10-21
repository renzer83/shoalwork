import type { StepState } from "@shoalwork/api-client"
import { cleanup, render } from "@testing-library/react"
import { PaperProvider } from "react-native-paper"
import { afterEach, describe, expect, it } from "vitest"
import { type DagStep, DagView } from "../src/components/dag/DagView.js"
import { edgePath, layoutDag } from "../src/components/dag/dag-layout.js"
import { themeFor } from "../src/index.js"

// A five-step plan: 1 feeds 2 and 3, 2 and 3 feed 4, 4 feeds 5.
const FIXTURE: ReadonlyArray<{ readonly id: string; readonly dependsOn: ReadonlyArray<string> }> = [
  { id: "s1", dependsOn: [] },
  { id: "s2", dependsOn: ["s1"] },
  { id: "s3", dependsOn: ["s1"] },
  { id: "s4", dependsOn: ["s2", "s3"] },
  { id: "s5", dependsOn: ["s4"] },
]

const step = (id: string, state: StepState): DagStep => ({
  id,
  title: `Passo ${id}`,
  state,
  costUsd: 0,
  dependsOn: FIXTURE.find((candidate) => candidate.id === id)?.dependsOn ?? [],
})

afterEach(cleanup)

describe("layoutDag", () => {
  it("lays out the same fixture the same way every time", () => {
    expect(layoutDag(FIXTURE)).toEqual(layoutDag(FIXTURE))
  })

  it("places every step and sets the graph size", () => {
    const layout = layoutDag(FIXTURE)
    expect(layout.nodes.map((node) => node.id).sort()).toEqual(["s1", "s2", "s3", "s4", "s5"])
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it("draws one edge per dependency, from the dependency to the dependent step", () => {
    const layout = layoutDag(FIXTURE)
    const pairs = layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort()
    expect(pairs).toEqual(["s1>s2", "s1>s3", "s2>s4", "s3>s4", "s4>s5"])
  })

  it("ignores a dependency on a step that is not in the plan", () => {
    const layout = layoutDag([{ id: "a", dependsOn: ["ghost"] }])
    expect(layout.edges).toEqual([])
    expect(layout.nodes.map((node) => node.id)).toEqual(["a"])
  })

  it("runs left to right: a dependency sits left of the step that waits for it", () => {
    const layout = layoutDag(FIXTURE)
    const x = (id: string) => layout.nodes.find((node) => node.id === id)?.x ?? Number.NaN
    expect(x("s1")).toBeLessThan(x("s2"))
    expect(x("s2")).toBeLessThan(x("s4"))
    expect(x("s4")).toBeLessThan(x("s5"))
  })
})

describe("edgePath", () => {
  it("is empty for an edge without points and a curve from the first to the last point otherwise", () => {
    expect(edgePath([])).toBe("")
    expect(
      edgePath([
        { x: 0, y: 0 },
        { x: 10, y: 4 },
      ]),
    ).toBe("M 0 0 C 5 0, 5 4, 10 4")
  })
})

const show = (steps: ReadonlyArray<DagStep>) => {
  const view = render(
    <PaperProvider theme={themeFor("light")}>
      <DagView steps={steps} />
    </PaperProvider>,
  )
  return view
}

describe("DagView", () => {
  it("draws a box per step and a curve per dependency", () => {
    const view = show(FIXTURE.map((candidate) => step(candidate.id, "pending")))
    expect(view.container.querySelectorAll("rect")).toHaveLength(5)
    expect(view.container.querySelectorAll("path")).toHaveLength(5)
  })

  it("draws step titles as plain text", () => {
    const view = show([step("s1", "done")])
    expect(view.container.textContent).toContain("Passo s1")
  })

  it("recolours a box when its step changes state", () => {
    const before = show([step("s1", "running")])
    const strokeBefore = before.container.querySelector("rect")?.getAttribute("stroke")
    before.unmount()

    const after = show([step("s1", "done")])
    const strokeAfter = after.container.querySelector("rect")?.getAttribute("stroke")
    expect(strokeBefore).toBeDefined()
    expect(strokeAfter).toBeDefined()
    expect(strokeAfter).not.toBe(strokeBefore)
  })
})
