import type { MessageKey } from "./en.js"
import { ptBot } from "./pt-BR-bot.js"
import { ptCore } from "./pt-BR-core.js"
import { ptFarol } from "./pt-BR-farol.js"
import { ptOps } from "./pt-BR-ops.js"

// Every key of the English table must be here: a missing one is a type error.
export const ptBR: Readonly<Record<MessageKey, string>> = { ...ptCore, ...ptBot, ...ptOps, ...ptFarol }
