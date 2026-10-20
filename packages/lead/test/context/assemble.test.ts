import { describe, expect, it } from "vitest"
import { assemble, BLOCK_ORDER, type Block, type BlockItem, fitBlock } from "../../src/context/assemble.js"
import { estimateTokens } from "../../src/context/tokens.js"

// Small deterministic generator (mulberry32): the same seed always gives the same cases.
const seeded = (seed: number) => {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const item = (text: string, score?: number): BlockItem => ({ text, score })

// With `hugeFixed` the fixed blocks (except the task) are much bigger than any budget the tests use.
const randomBlocks = (random: () => number, hugeFixed = false): ReadonlyArray<Block> =>
  BLOCK_ORDER.map((name) => {
    const fixed = name === "instructions" || name === "rules" || name === "task" || name === "acceptance"
    if (name === "task") {
      return { name, fixed, maxTokens: 50, heading: "# task", items: [item("task0 a small task", 3)] }
    }
    if (hugeFixed && fixed) {
      return {
        name,
        fixed,
        maxTokens: 10_000,
        heading: `# ${name}`,
        items: Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) =>
          item(`${name}-${i} ${"x".repeat(200 + Math.floor(random() * 2000))}`, 5 - i),
        ),
      }
    }
    const count = Math.floor(random() * (fixed ? 3 : 12))
    return {
      name,
      fixed,
      maxTokens: 50 + Math.floor(random() * 400),
      heading: `# ${name}`,
      items: Array.from({ length: count }, (_, i) =>
        item(
          `${name}-${i} ${"x".repeat(Math.floor(random() * (fixed ? 40 : 600)))}`,
          Math.floor(random() * 10),
        ),
      ),
    }
  })

describe("assemble", () => {
  it("respects the budget in 20 seeded random cases", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = seeded(seed)
      const blocks = randomBlocks(random)
      const budget = 600 + Math.floor(random() * 3000)
      const reserve = Math.floor(random() * 300)
      const result = assemble(blocks, budget, reserve)
      expect(result.used).toBe(estimateTokens(result.text))
      expect(result.used).toBeLessThanOrEqual(budget - reserve)
    }
  })

  it("cuts fixed blocks only as a last resort: rules, then acceptance, then instructions, never the task", () => {
    const block = (name: Block["name"], size: number, count: number): Block => ({
      name,
      fixed: true,
      maxTokens: 10_000,
      items: Array.from({ length: count }, (_, i) => item(`${name}${i}${"x".repeat(size)}`, count - i)),
    })
    const memory: Block = { name: "memory", fixed: false, maxTokens: 1000, items: [item("m".repeat(40), 1)] }
    const blocks = [
      block("instructions", 200, 2),
      block("rules", 200, 2),
      block("acceptance", 200, 2),
      block("task", 40, 1),
      memory,
    ]
    const roomy = assemble(blocks, 10_000, 0)
    expect(roomy.dropped).toEqual([])
    // Memory goes first, then the rules, then the acceptance, then the instructions.
    const tight = (available: number) => assemble(blocks, available, 0)
    expect(tight(roomy.used - 5).dropped).toEqual([{ block: "memory", items: 1 }])
    expect(tight(roomy.used - 25).dropped).toEqual([
      { block: "rules", items: 1 },
      { block: "memory", items: 1 },
    ])
    const squeezed = tight(60)
    expect(squeezed.used).toBeLessThanOrEqual(60)
    expect(squeezed.text).toContain("task0")
    expect(squeezed.dropped).toEqual([
      { block: "instructions", items: 2 },
      { block: "rules", items: 2 },
      { block: "memory", items: 1 },
      { block: "acceptance", items: 2 },
    ])
  })

  it("keeps to the budget in 20 seeded cases whose fixed blocks are bigger than the budget", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = seeded(seed * 31)
      const blocks = randomBlocks(random, true)
      const budget = 120 + Math.floor(random() * 1500)
      const reserve = Math.floor(random() * 60)
      const result = assemble(blocks, budget, reserve)
      expect(result.used).toBeLessThanOrEqual(budget - reserve)
      // The task block is small enough to fit and is never cut.
      for (const task of blocks.filter((b) => b.name === "task")) {
        for (const line of task.items) expect(result.text).toContain(line.text)
      }
      const before = assemble(blocks, 10_000_000, 0)
      if (before.used > budget - reserve) expect(result.dropped.length).toBeGreaterThan(0)
    }
  })

  it("counts the items a builder left out (omitted) with the ones it dropped", () => {
    const block: Block = { name: "rules", fixed: true, maxTokens: 100, omitted: 2, items: [item("x")] }
    const memory: Block = { name: "memory", fixed: false, maxTokens: 100, items: [item("a".repeat(800))] }
    expect(assemble([block, memory], 1000, 0).dropped).toEqual([
      { block: "rules", items: 2 },
      { block: "memory", items: 1 },
    ])
  })

  it("keeps the canonical order whatever the order given", () => {
    const blocks = [...randomBlocks(seeded(7))].reverse()
    const text = assemble(blocks, 1_000_000, 0).text
    const positions = BLOCK_ORDER.flatMap((name) => {
      const at = text.indexOf(`# ${name}`)
      return at < 0 ? [] : [at]
    })
    expect(positions.length).toBeGreaterThan(3)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("drops the lowest-scored items of a block first and whole items only", () => {
    const memory: Block = {
      name: "memory",
      fixed: false,
      maxTokens: 25,
      items: [item("low ".repeat(8), 1), item("high ".repeat(8), 9), item("mid ".repeat(8), 5)],
    }
    const result = assemble([memory], 1000, 0)
    expect(result.text).toBe(`${"high ".repeat(8)}\n${"mid ".repeat(8)}`)
    expect(result.dropped).toEqual([{ block: "memory", items: 1 }])
  })

  it("takes the room from the biggest block when the whole is over the budget", () => {
    const memory: Block = {
      name: "memory",
      fixed: false,
      maxTokens: 1000,
      items: [item("m".repeat(100), 2), item("n".repeat(100), 1)],
    }
    const code: Block = {
      name: "code",
      fixed: false,
      maxTokens: 1000,
      items: [item("c".repeat(400), 3), item("d".repeat(400), 1)],
    }
    const result = assemble([memory, code], 170, 0)
    expect(result.text).toContain("c".repeat(400))
    expect(result.text).toContain("m".repeat(100))
    expect(result.text).not.toContain("d".repeat(400))
    expect(result.text).toContain("n".repeat(100))
  })

  it("renders no heading for a block that has no items left", () => {
    const code: Block = {
      name: "code",
      fixed: false,
      maxTokens: 1,
      heading: "# Code",
      items: [item("x".repeat(100))],
    }
    expect(assemble([code], 1000, 0).text).toBe("")
  })

  it("subtracts the answer reserve from the budget", () => {
    const memory: Block = { name: "memory", fixed: false, maxTokens: 1000, items: [item("m".repeat(400))] }
    expect(assemble([memory], 150, 0).text).not.toBe("")
    expect(assemble([memory], 150, 100).text).toBe("")
    expect(assemble([memory], 50, 100).text).toBe("")
  })

  it("is deterministic: the same input gives the same text, ties broken by text", () => {
    const blocks = randomBlocks(seeded(3))
    const reversed = blocks.map((block) => ({ ...block, items: [...block.items].reverse() }))
    expect(assemble(blocks, 900, 100)).toEqual(assemble(blocks, 900, 100))
    const tied: Block = { name: "memory", fixed: false, maxTokens: 100, items: [item("b", 1), item("a", 1)] }
    expect(assemble([tied], 100, 0).text).toBe("a\nb")
    expect(assemble([{ ...tied, items: [...tied.items].reverse() }], 100, 0).text).toBe("a\nb")
    expect(assemble(reversed, 100000, 0).used).toBe(assemble(blocks, 100000, 0).used)
  })
})

describe("fitBlock", () => {
  const block = (items: ReadonlyArray<BlockItem>, maxTokens: number): Block => ({
    name: "acceptance",
    fixed: true,
    maxTokens,
    items,
  })

  it("skips an item that does not fit and goes on with the next, counting what it left out", () => {
    const fitted = fitBlock(block([item("a".repeat(40), 3), item("b".repeat(200), 2), item("c", 1)], 20))
    expect(fitted.items.map((i) => i.text[0])).toEqual(["a", "c"])
    expect(fitted.omitted).toBe(1)
  })

  it("counts the heading and the note against the cap, and leaves a block that fits alone", () => {
    const small = block([item("abcd")], 1000)
    expect(fitBlock(small)).toBe(small)
    expect(fitBlock({ ...small, maxTokens: 2, heading: "# a long heading" }).items).toEqual([])
  })
})
