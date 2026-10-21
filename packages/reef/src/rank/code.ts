import { Effect } from "effect"
import type { CodeCandidate, CodeSearchHit } from "../indexer/search.js"
import type { Candidate, RankError, RankedCandidate, RankerShape } from "./ranker.js"
import type { SignalValues } from "./signals.js"

// The code a briefing takes: the best `k` hits, re-scored by the ranker, and every candidate the ranker considered
// (with its normalized signals and whether it made the cut), which context.assembled keeps for the weekly tuning.
export interface RankedCode {
  readonly hits: ReadonlyArray<CodeSearchHit>
  readonly considered: ReadonlyArray<{
    readonly id: string
    readonly used: boolean
    readonly signals: SignalValues
  }>
}

export const toRankCandidate = ({ hit, raw }: CodeCandidate): Candidate => ({
  id: hit.id,
  kind: "chunk",
  path: hit.path,
  text: hit.content,
  raw,
})

// Pure: ranked candidates back to search hits. `score` becomes the ranker's score.
export const rankedHits = (
  candidates: ReadonlyArray<CodeCandidate>,
  ranked: ReadonlyArray<RankedCandidate>,
  k: number,
): RankedCode => {
  const byId = new Map(candidates.map((candidate) => [candidate.hit.id, candidate.hit]))
  const hits: Array<CodeSearchHit> = []
  const considered: Array<RankedCode["considered"][number]> = []
  for (const entry of ranked) {
    const hit = byId.get(entry.id)
    if (hit === undefined) continue
    const used = hits.length < k
    if (used) hits.push({ ...hit, score: entry.score })
    considered.push({ id: entry.id, used, signals: entry.signals })
  }
  return { hits, considered }
}

// Ranks the raw candidates of the indexer for a task: `activeFiles` are the files the task is about.
export const rankCode = (
  ranker: RankerShape,
  candidates: ReadonlyArray<CodeCandidate>,
  ctx: { readonly repo: string; readonly activeFiles: ReadonlyArray<string>; readonly query: string },
  k: number,
): Effect.Effect<RankedCode, RankError> =>
  ranker
    .rank(candidates.map(toRankCandidate), ctx)
    .pipe(Effect.map((ranked) => rankedHits(candidates, ranked, k)))
