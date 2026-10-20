// Stable id of a repo: the index rows (code_chunks.repo) and the MCP scope of a token both use it. It comes from the
// RepoRef url, never from a worktree path (T-040). Credentials, a trailing ".git", the host's case and a default port
// are dropped, so the same repo written as an https url, an ssh url or an scp-like address keeps the same key.
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/
const CREDENTIALS = /^[^@/\s]+@/
// The port a scheme uses by default: a URL that names it is the same address as one that does not.
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
  "ssh:": "22",
  "git+ssh:": "22",
  "ssh+git:": "22",
  "git:": "9418",
}

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

const trimPath = (path: string): string =>
  path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")

const decodePath = (path: string): string => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

// The host as the key spells it: lower case, and a port only when it is not the scheme's default.
const hostOf = (url: URL): string => {
  const port = url.port
  return port === "" || port === DEFAULT_PORTS[url.protocol]
    ? url.hostname.toLowerCase()
    : `${url.hostname.toLowerCase()}:${port}`
}

export const repoKeyOf = (url: string): string => {
  const raw = url.trim()
  const parsed = parseUrl(raw)
  if (parsed !== undefined && parsed.protocol === "file:") {
    return trimPath(decodePath(parsed.pathname))
  }
  if (parsed !== undefined && parsed.host !== "") {
    return `${hostOf(parsed)}/${trimPath(decodePath(parsed.pathname)).replace(/^\/+/, "")}`
  }
  // Without a scheme the credentials come first ("user:pass@host/path"); they must not be read as the scp host.
  const bare = raw.replace(CREDENTIALS, "")
  const scp = SCP_LIKE.exec(bare)
  if (scp !== null && scp[1] !== undefined && scp[2] !== undefined) {
    return `${scp[1].toLowerCase()}/${trimPath(scp[2]).replace(/^\/+/, "")}`
  }
  return trimPath(bare)
}
