// Token estimate used for every context budget: chars / 4, rounded up. A real tokenizer replaces this in F7; every
// caller goes through this function so that the swap is one line.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
