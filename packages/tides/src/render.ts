import type { Event, Tide } from "@shoalwork/contracts"

// Walks a dotted path ("payload.action") through plain objects. Anything that is not an object on the way is undefined.
export const lookupPath = (root: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) {
      return undefined
    }
    return Reflect.get(node, key)
  }, root)

// Event values are data (R14): a string enters the prompt as a JSON string literal, so quotes and newlines of the event
// cannot close the template's own text. Long values are cut.
const MAX_VALUE_CHARS = 2000
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g

export const renderValue = (value: unknown): string => {
  if (value === undefined) {
    return "null"
  }
  const text = JSON.stringify(value) ?? "null"
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}..."` : text
}

// Total size of a rendered title or prompt: whatever the placeholders bring, the task text stays bounded.
export const MAX_RENDERED_CHARS = 8000

// One pass over the template: a placeholder's value is never rendered again, so it cannot introduce another one.
export const renderTemplate = (template: string, root: unknown): string => {
  const text = template.replace(PLACEHOLDER, (_match, path: string) => renderValue(lookupPath(root, path)))
  return text.length > MAX_RENDERED_CHARS ? text.slice(0, MAX_RENDERED_CHARS) : text
}

// An event Tide fires for an event of its type whose filter paths all hold the filter values (equality, no code).
export const tideMatches = (tide: Tide, event: Event): boolean =>
  tide.kind === "event" &&
  tide.eventType === event.type &&
  Object.entries(tide.eventFilter ?? {}).every(([path, expected]) => lookupPath(event, path) === expected)
