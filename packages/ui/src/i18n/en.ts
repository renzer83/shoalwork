import { enBot } from "./en-bot.js"
import { enCore } from "./en-core.js"
import { enFarol } from "./en-farol.js"
import { enOps } from "./en-ops.js"
import { enShell } from "./en-shell.js"

// The English table is the source of the message keys: pt-BR must define every one of them.
export const en = { ...enCore, ...enBot, ...enOps, ...enFarol, ...enShell } as const

export type MessageKey = keyof typeof en
