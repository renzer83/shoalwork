// The pure rules of the Executores screen (T-117): what a gauge reads as, how a quality table sorts, how a status reads.

export type DoctorStatus = "ok" | "drift" | "missing" | "auth_missing"
export type LoginState = "logged_in" | "logged_out" | "unknown"

export const DOCTOR_LABEL: Readonly<Record<DoctorStatus, string>> = {
  ok: "OK",
  drift: "versão diferente do pin",
  missing: "CLI ausente",
  auth_missing: "sem login",
}

export const LOGIN_LABEL: Readonly<Record<LoginState, string>> = {
  logged_in: "logado",
  logged_out: "sem login",
  unknown: "não verificado",
}

// From this share of the window used, the gauge is an alert (red).
export const ALERT_RATIO = 0.8

export type GaugeTone = "normal" | "alert"

export const gaugeTone = (usedRatio: number): GaugeTone => (usedRatio >= ALERT_RATIO ? "alert" : "normal")

export interface QualityRow {
  readonly kind: string
  readonly okRate: number
  readonly n: number
  readonly avgUsd: number
}

export type QualityKey = "kind" | "okRate" | "n" | "avgUsd"
export type SortDirection = "asc" | "desc"

export const QUALITY_HEADERS: ReadonlyArray<{ readonly key: QualityKey; readonly label: string }> = [
  { key: "kind", label: "Tipo" },
  { key: "okRate", label: "Sucesso" },
  { key: "n", label: "Execuções" },
  { key: "avgUsd", label: "Custo médio" },
]

// A stable sort by one column. Text compares by locale, numbers by value.
export const sortQuality = (
  rows: ReadonlyArray<QualityRow>,
  key: QualityKey,
  direction: SortDirection,
): ReadonlyArray<QualityRow> => {
  const sign = direction === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === "kind") return sign * a.kind.localeCompare(b.kind)
    return sign * (a[key] - b[key])
  })
}

export const versionText = (installed: string | null, pinned: string | null): string =>
  `instalado ${installed ?? "—"} · pin ${pinned ?? "—"}`

export const percentText = (ratio: number): string => `${Math.round(ratio * 100)}%`
