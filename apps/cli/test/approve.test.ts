import { it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { approvalDecide } from "../src/commands/approve.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const ID = "apr_0b0b0b0b-0000-4000-8000-000000000003"
const APPROVAL = {
  id: ID,
  taskId: "task_0b0b0b0b-0000-4000-8000-000000000002",
  botId: "bot_0b0b0b0b-0000-4000-8000-000000000001",
  action: { tool: "Bash", input: "rm -rf build" },
  risk: "irreversible",
  status: "approved",
  requestedAt: "2026-10-20T10:00:00.000Z",
  expiresAt: "2026-10-20T12:00:00.000Z",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("approve and deny", () => {
  it.effect("posts the decision with via cli and reports what was decided", () =>
    Effect.gen(function* () {
      const mock = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ result: "resolved", approval: APPROVAL }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      )
      vi.stubGlobal("fetch", mock)
      const result = yield* approvalDecide(SETTINGS, "approved", ID)
      expect(result).toEqual({ result: "resolved", status: "approved" })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe(`http://localhost:28900/approvals/${ID}`)
      expect(JSON.parse(String(init?.body))).toEqual({ decision: "approved", via: "cli" })
    }),
  )

  it.effect("rejects an id that is not an approval id before any request", () =>
    Effect.gen(function* () {
      const mock = vi.fn()
      vi.stubGlobal("fetch", mock)
      const error = yield* approvalDecide(SETTINGS, "denied", "task_x").pipe(Effect.flip)
      expect(error).toBeInstanceOf(UsageError)
      expect(mock).not.toHaveBeenCalled()
    }),
  )
})
