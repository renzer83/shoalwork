import { repoKeyOf } from "@shoalwork/contracts"
import { type IndexerShape, type RankerShape, rankCode } from "@shoalwork/reef"
import { Effect } from "effect"
import type { BriefingRankedCode } from "./briefing.js"

// The code search of a briefing with the six signals: the index's raw candidates for the repo the task names (under the
// key the MCP scope uses), ranked against the files the task is about.
export const makeRankedCode =
  (indexer: IndexerShape, ranker: RankerShape): BriefingRankedCode =>
  (repo, query, activeFiles, k) => {
    const key = repoKeyOf(repo.url)
    return indexer
      .candidates(key, query)
      .pipe(Effect.flatMap((found) => rankCode(ranker, found, { repo: key, activeFiles, query }, k)))
  }
