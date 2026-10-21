import { approxCounter } from "./tokenizer-approx.js"
import { DEFAULT_TOKENIZER_CONFIG, factorsFor } from "./tokenizer-config.js"

// Token estimate with the built-in factors (config/tokenizer.yaml, default executor): code, Portuguese and English are
// counted at their own factor. A Lead counts with the Tokenizer, calibrated per executor (tokenizer.ts); this is the
// count for code that has no Tokenizer at hand.
const DEFAULT_COUNTER = approxCounter(factorsFor(DEFAULT_TOKENIZER_CONFIG, "default"))
export const estimateTokens = (text: string): number => DEFAULT_COUNTER(text)
