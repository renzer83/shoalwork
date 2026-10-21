import type { Translate } from "../i18n/index.js"

// HttpError carries the HTTP status (0 when the core never answered); anything else counts as no answer.
export const failedStatus = (error: unknown): number =>
  error instanceof Object && "status" in error ? Number(error.status) : 0

const bodyDetail = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const error: unknown = Reflect.get(body, "error")
  const reason: unknown = Reflect.get(body, "reason")
  const where: unknown = Reflect.get(body, "where")
  const parts = [error, reason, where].filter((part): part is string => typeof part === "string")
  return parts.length === 0 ? undefined : parts.join(" · ")
}

// What the user reads when a call failed: the status, and the core's own reason when it gave one.
export const failureText = (error: unknown, t: Translate): string => {
  const status = failedStatus(error)
  const body: unknown = error instanceof Object && "body" in error ? error.body : undefined
  const head = status === 0 ? t("common.noAnswer") : t("common.httpStatus", { status })
  const detail = bodyDetail(body)
  return detail === undefined ? head : `${head}: ${detail}`
}
