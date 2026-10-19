// Dates are stored as TEXT ISO-8601 UTC (ADR-001); generated here, not by SQL defaults.
export const nowIso = (): string => new Date().toISOString()
