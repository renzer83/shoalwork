export const DEFAULT_PORT = "28900"

// APP_URL is where the core listens; blank falls back to the local default (same rule as the core's own config).
export const resolveAppUrl = (env: Readonly<Record<string, string | undefined>>): string => {
  const explicit = env.APP_URL?.trim()
  if (explicit !== undefined && explicit !== "") {
    return explicit
  }
  const port = env.PORT?.trim()
  return `http://127.0.0.1:${port === undefined || port === "" ? DEFAULT_PORT : port}`
}

export const APP_URL_ARG = "--shoalwork-app-url="
