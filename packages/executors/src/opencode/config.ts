import type { TankError } from "@shoalwork/contracts"
import { Tank, type TankContext } from "@shoalwork/tank"
import { Effect } from "effect"
import type { OpencodePermission } from "./args.js"

// Providers that need an entry in opencode.json. zai-coding-plan is built into opencode: it reads ZHIPU_API_KEY from
// the env and needs no entry, so it writes nothing. No key is ever written into the file.
export type OpencodeProvider = "ollama" | "zai-coding-plan"

export const OLLAMA_BASE_URL = "http://localhost:11434/v1"

const OLLAMA_ENTRY = {
  npm: "@ai-sdk/openai-compatible",
  name: "Ollama",
  options: { baseURL: OLLAMA_BASE_URL },
} as const

// Document for <cwd>/opencode.json. Always written, even when empty, so a readonly rule from an earlier run in the
// same worktree never survives into an edit run.
export const opencodeConfigFor = (
  providers: ReadonlyArray<OpencodeProvider>,
  permission?: OpencodePermission,
): string => {
  const provider = providers.includes("ollama") ? { ollama: OLLAMA_ENTRY } : undefined
  const document = {
    $schema: "https://opencode.ai/config.json",
    ...(permission === undefined ? {} : { permission }),
    ...(provider === undefined ? {} : { provider }),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

// Writes opencode.json in the run's cwd through the Tank (confined to the worktree, works in server mode too).
export const writeOpencodeConfig = (
  ctx: TankContext,
  providers: ReadonlyArray<OpencodeProvider>,
  permission?: OpencodePermission,
): Effect.Effect<void, TankError, Tank> =>
  Effect.gen(function* () {
    const tank = yield* Tank
    yield* tank.writeFile(ctx, "opencode.json", opencodeConfigFor(providers, permission))
  })
