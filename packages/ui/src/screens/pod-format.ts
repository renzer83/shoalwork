import type { Translate } from "../i18n/index.js"

// Display helpers of the Pod screens. Times are shown relative to `now`, in the reader's language.
export const money = (usd: number): string => `US$ ${usd.toFixed(2)}`

export const startedAgo = (iso: string, now: number, t: Translate): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return t("time.minAgo", { count: minutes })
  return t("time.hoursAgo", { count: Math.floor(minutes / 60) })
}

export const clock = (iso: string): string => {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
