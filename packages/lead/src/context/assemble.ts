import { estimateTokens } from "./tokens.js"

// Canonical order of the prompt: what is the same from run to run comes first, so that a provider's prompt cache
// keeps matching the longest possible prefix; what changes with the task comes last.
export const BLOCK_ORDER = [
  "instructions",
  "rules",
  "memory",
  "code",
  "working",
  "acceptance",
  "handoff",
  "task",
] as const
export type BlockName = (typeof BLOCK_ORDER)[number]

export interface BlockItem {
  readonly text: string
  readonly score?: number | undefined
}

export interface Block {
  readonly name: BlockName
  readonly items: ReadonlyArray<BlockItem>
  // Token cap of a block that is cut by assemble. A fixed block is trimmed by its builder (fitBlock) and only cut
  // by assemble as a last resort, to keep to the budget.
  readonly maxTokens: number
  readonly fixed: boolean
  // Rendered before the items, only when the block has items left.
  readonly heading?: string | undefined
  readonly note?: string | undefined
  // Items the builder left out (or cut short) before assembling; they are reported with the ones assemble drops.
  readonly omitted?: number | undefined
}

export interface Assembled {
  readonly text: string
  readonly used: number
  readonly dropped: ReadonlyArray<{ readonly block: string; readonly items: number }>
}

// Which block gives up room first when the whole is over the budget and sizes tie, and the order in which fixed
// blocks are cut once nothing else is left. The task block is never cut.
const CUT_ORDER: ReadonlyArray<BlockName> = [
  "code",
  "working",
  "memory",
  "rules",
  "acceptance",
  "instructions",
  "task",
]
const NEVER_CUT: BlockName = "task"

// Best first: score descending (a missing score is 0), then text ascending, so the same input is the same output.
const rank = (items: ReadonlyArray<BlockItem>): Array<BlockItem> =>
  [...items].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  )

const render = (block: Block, items: ReadonlyArray<BlockItem>): string =>
  items.length === 0
    ? ""
    : [
        ...(block.heading === undefined ? [] : [block.heading]),
        ...(block.note === undefined ? [] : [block.note]),
        ...items.map((item) => item.text),
      ].join("\n")

// Trims a block to its cap without cutting any item: items are taken in rank order, one that does not fit is skipped
// and the next is tried. What is left out is counted in `omitted`, so it shows up in the report.
export const fitBlock = (block: Block): Block => {
  const kept: Array<BlockItem> = []
  for (const item of rank(block.items)) {
    if (estimateTokens(render(block, [...kept, item])) <= block.maxTokens) kept.push(item)
  }
  const skipped = block.items.length - kept.length
  return skipped === 0 ? block : { ...block, items: kept, omitted: (block.omitted ?? 0) + skipped }
}

interface State {
  readonly block: Block
  items: Array<BlockItem>
  dropped: number
}

// Puts the blocks in the canonical order and fits them in budgetTokens - reserveForAnswer (the room the model keeps
// for its answer). Blocks that can be cut first keep to their own cap, then, while the whole is still over the
// budget, the block using the most tokens loses its lowest-ranked item. If only fixed blocks are left over the
// budget, they lose their lowest-ranked items too (rules, then acceptance, then instructions), never the task block.
// An item is dropped whole, never cut. `used` is within the budget whenever the task block alone is.
export const assemble = (
  blocks: ReadonlyArray<Block>,
  budgetTokens: number,
  reserveForAnswer: number,
): Assembled => {
  const available = Math.max(0, budgetTokens - reserveForAnswer)
  const states: Array<State> = BLOCK_ORDER.flatMap((name) =>
    blocks
      .filter((block) => block.name === name)
      .map((block) => ({ block, items: rank(block.items), dropped: 0 })),
  )
  const cost = (state: State): number => estimateTokens(render(state.block, state.items))
  const whole = (): string =>
    states
      .map((state) => render(state.block, state.items))
      .filter((part) => part !== "")
      .join("\n\n")
  const dropLast = (state: State): void => {
    state.items.pop()
    state.dropped += 1
  }
  const order = (state: State): number => CUT_ORDER.indexOf(state.block.name)

  for (const state of states) {
    if (state.block.fixed) continue
    while (state.items.length > 0 && cost(state) > state.block.maxTokens) dropLast(state)
  }
  for (;;) {
    if (estimateTokens(whole()) <= available) break
    const loose = states.filter((state) => !state.block.fixed && state.items.length > 0)
    const [first, ...rest] = loose
    if (first !== undefined) {
      const victim = rest.reduce((best, state) => {
        const diff = cost(state) - cost(best)
        return diff > 0 || (diff === 0 && order(state) < order(best)) ? state : best
      }, first)
      dropLast(victim)
      continue
    }
    const fixed = states
      .filter((state) => state.block.name !== NEVER_CUT && state.items.length > 0)
      .sort((a, b) => order(a) - order(b))
    const victim = fixed[0]
    if (victim === undefined) break
    dropLast(victim)
  }

  const text = whole()
  const dropped = BLOCK_ORDER.flatMap((name) => {
    const own = states.filter((s) => s.block.name === name)
    const items = own.reduce((sum, s) => sum + s.dropped + (s.block.omitted ?? 0), 0)
    return items > 0 ? [{ block: name, items }] : []
  })
  return { text, used: estimateTokens(text), dropped }
}
