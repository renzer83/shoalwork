// Display helpers of the Pod screens. Times are shown as "h min ago" relative to `now`; no locale data is needed.
export const money = (usd: number): string => `US$ ${usd.toFixed(2)}`

export const startedAgo = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ago`
}

export const clock = (iso: string): string => {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
