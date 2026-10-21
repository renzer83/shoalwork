import { repoKeyOf } from "@shoalwork/contracts"
import type { IndexerShape, RankerShape } from "@shoalwork/reef"
import type { BriefingCode } from "./briefing.js"
import { type InjectDeps, makeInjector } from "./inject.js"
import { makeRankedCode } from "./ranked-code.js"

export interface InjectorSources
  extends Pick<InjectDeps, "tank" | "memory" | "recordAssembled" | "raiseError"> {
  // The repo index for the briefing's code block (T-041). Without it the briefing carries no code.
  readonly indexer?: IndexerShape | undefined
  // Six-signal ranking of the index's candidates (T-096); needs the indexer.
  readonly ranker?: RankerShape | undefined
  // config/context.yaml, read once by the composition root.
  readonly context?: InjectDeps["config"]
}

// The injector of a run: the code block searches the repo the task names under the same key the MCP scope uses, ranked
// when there is a Ranker, in the index's own order otherwise.
export const makeInjectorFor = (sources: InjectorSources) => {
  const { indexer, ranker } = sources
  const code: BriefingCode | undefined =
    indexer === undefined ? undefined : (repo, query, k) => indexer.search(repoKeyOf(repo.url), query, k)
  return makeInjector({
    tank: sources.tank,
    memory: sources.memory,
    code,
    rankedCode: indexer === undefined || ranker === undefined ? undefined : makeRankedCode(indexer, ranker),
    config: sources.context,
    recordAssembled: sources.recordAssembled,
    raiseError: sources.raiseError,
  })
}
