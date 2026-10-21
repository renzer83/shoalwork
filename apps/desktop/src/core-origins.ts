// The origins of the core this window may talk to: the CSP connect-src and the CORS headers both read this list.
export const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

export class CoreOrigins {
  private readonly origins = new Set<string>()

  constructor(initial: ReadonlyArray<string> = []) {
    for (const url of initial) {
      this.add(url)
    }
  }

  // False when the value is not an http(s) URL.
  add(url: string): boolean {
    const origin = originOf(url)
    if (origin === undefined) {
      return false
    }
    this.origins.add(origin)
    return true
  }

  has(url: string): boolean {
    const origin = originOf(url)
    return origin !== undefined && this.origins.has(origin)
  }

  list(): Array<string> {
    return [...this.origins]
  }
}
