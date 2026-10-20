// A fence longer than any run of backticks inside the content, so that the content cannot close it.
export const fenceFor = (content: string): string => {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  return "`".repeat(Math.max(3, longest + 1))
}

// The content as an inert code block.
export const fenced = (content: string): string => {
  const fence = fenceFor(content)
  return `${fence}\n${content}\n${fence}`
}

// At most `max` characters, cut at the end of a line, with a visible marker when something was left out.
export const clipLines = (content: string, max: number): string => {
  if (content.length <= max) return content
  const head = content.slice(0, max)
  return `${head.slice(0, Math.max(head.lastIndexOf("\n"), 0))}\n...`
}
