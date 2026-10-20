import * as acp from "@agentclientprotocol/sdk"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { type PromptCall, text, update } from "./fake-agent.js"
import { CWD, fakePolicy, kinds, runAgent, task, withRealPolicy } from "./harness.js"

const OPTIONS: Array<acp.PermissionOption> = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "yes-always", name: "Allow always", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
]

const ask = (
  call: PromptCall,
  toolCall: acp.ToolCallUpdate,
  options: Array<acp.PermissionOption> = OPTIONS,
) =>
  call.client.request(acp.methods.client.session.requestPermission, {
    sessionId: call.params.sessionId,
    toolCall,
    options,
  })

const EDIT: acp.ToolCallUpdate = {
  toolCallId: "t1",
  kind: "edit",
  title: "edit a.ts",
  locations: [{ path: `${CWD}/a.ts` }],
}

// One permission request in one run; the outcome the agent got and the events of the run.
const outcomeOf = (policy: Parameters<typeof runAgent>[1], toolCall: acp.ToolCallUpdate) =>
  Effect.gen(function* () {
    let outcome: acp.RequestPermissionResponse | undefined
    const { events } = yield* runAgent(
      {
        onPrompt: async (call) => {
          outcome = await ask(call, toolCall)
          return { stopReason: "end_turn" }
        },
      },
      policy,
    )
    return { outcome, events }
  })

const ALLOW = { outcome: { outcome: "selected", optionId: "yes" } }
const REJECT = { outcome: { outcome: "selected", optionId: "no" } }
const CANCELLED = { outcome: { outcome: "cancelled" } }

describe("acp request_permission with a fake policy", () => {
  it.effect("allow selects allow_once and the run goes on", () =>
    Effect.gen(function* () {
      const { policy, asked } = fakePolicy({ Edit: "allow" })
      let outcome: acp.RequestPermissionResponse | undefined
      const { events } = yield* runAgent(
        {
          onPrompt: async (call) => {
            outcome = await ask(call, EDIT)
            await update(call, text("edited"))
            return { stopReason: "end_turn" }
          },
        },
        policy,
      )
      expect(outcome).toEqual(ALLOW)
      expect(kinds(events)).toEqual(["started", "text", "done"])
      expect(asked).toEqual([{ tool: "Edit", input: { file_path: `${CWD}/a.ts` }, resource: `${CWD}/a.ts` }])
    }),
  )

  it.effect("deny selects reject_once and the run goes on", () =>
    Effect.gen(function* () {
      const { outcome, events } = yield* outcomeOf(fakePolicy({ Edit: "deny" }).policy, EDIT)
      expect(outcome).toEqual(REJECT)
      expect(kinds(events)).toEqual(["started", "done"])
    }),
  )

  it.effect("ask reports approval_needed, cancels the request and ends the run with the process killed", () =>
    Effect.gen(function* () {
      let outcome: acp.RequestPermissionResponse | undefined
      const { policy } = fakePolicy({ Bash: "ask" }, "external")
      const { events, agent } = yield* runAgent(
        {
          onPrompt: async (call) => {
            outcome = await ask(call, {
              toolCallId: "t2",
              kind: "execute",
              title: "curl",
              rawInput: { command: "curl https://example.com" },
            })
            await update(call, text("late"))
            return { stopReason: "cancelled" }
          },
        },
        policy,
      )
      expect(outcome).toEqual(CANCELLED)
      expect(kinds(events)).toEqual(["started", "approval_needed"])
      expect(events[1]).toEqual({
        kind: "approval_needed",
        action: { tool: "Bash", input: { command: "curl https://example.com" } },
        risk: "external",
      })
      expect(agent.state.killed).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("a second ask in the same run is cancelled without a second approval_needed", () =>
    Effect.gen(function* () {
      const outcomes: Array<acp.RequestPermissionResponse> = []
      const { events } = yield* runAgent(
        {
          onPrompt: async (call) => {
            outcomes.push(...(await Promise.all([ask(call, EDIT), ask(call, { ...EDIT, toolCallId: "t3" })])))
            return { stopReason: "cancelled" }
          },
        },
        fakePolicy({}).policy,
      )
      expect(outcomes).toEqual([CANCELLED, CANCELLED])
      expect(events.filter((event) => event.kind === "approval_needed")).toHaveLength(1)
    }),
  )

  it.effect(
    "only once-options are used: allow and deny without them are cancelled, never an always option",
    () =>
      Effect.gen(function* () {
        const outcomes: Array<acp.RequestPermissionResponse> = []
        const { policy } = fakePolicy({ Edit: "allow", Read: "deny" })
        const onlyAlways: Array<acp.PermissionOption> = [
          { optionId: "ya", name: "Allow always", kind: "allow_always" },
          { optionId: "na", name: "Reject always", kind: "reject_always" },
        ]
        yield* runAgent(
          {
            onPrompt: async (call) => {
              outcomes.push(await ask(call, EDIT, onlyAlways))
              outcomes.push(
                await ask(
                  call,
                  { toolCallId: "t4", kind: "read", title: "r", locations: [{ path: `${CWD}/r` }] },
                  onlyAlways,
                ),
              )
              return { stopReason: "end_turn" }
            },
          },
          policy,
          task(),
        )
        expect(outcomes).toEqual([CANCELLED, CANCELLED])
      }),
  )
})

describe("acp request_permission with the real policy", () => {
  it.effect("read, search and fetch that name nothing ask at once, without consulting the policy", () =>
    withRealPolicy((policy, spy) =>
      Effect.gen(function* () {
        for (const kind of ["read", "search", "fetch"] as const) {
          const { outcome, events } = yield* outcomeOf(policy, {
            toolCallId: "n",
            kind,
            title: "x",
            locations: [],
          })
          expect(outcome).toEqual(CANCELLED)
          expect(events.at(-1)).toMatchObject({ kind: "approval_needed", risk: "external" })
        }
        expect(spy).toEqual([])
      }),
    ),
  )

  it.effect("a path from rawInput is judged: fetch uses the url, a secret file is denied", () =>
    withRealPolicy((policy, spy) =>
      Effect.gen(function* () {
        const fetched = yield* outcomeOf(policy, {
          toolCallId: "f",
          kind: "fetch",
          title: "get",
          rawInput: { url: "https://example.com/a" },
        })
        expect(fetched.outcome).toEqual(ALLOW)
        expect(spy[0]).toEqual({
          tool: "WebFetch",
          input: { url: "https://example.com/a" },
          resource: "https://example.com/a",
        })
        const secret = yield* outcomeOf(policy, {
          toolCallId: "s",
          kind: "read",
          title: "env",
          rawInput: { absolute_path: `${CWD}/.env` },
        })
        expect(secret.outcome).toEqual(REJECT)
      }),
    ),
  )

  it.effect("every location is judged: one outside the workspace asks, a secret among them denies", () =>
    withRealPolicy((policy, spy) =>
      Effect.gen(function* () {
        const inside = yield* outcomeOf(policy, {
          ...EDIT,
          locations: [{ path: `${CWD}/a.ts` }, { path: `${CWD}/b.ts` }],
        })
        expect(inside.outcome).toEqual(ALLOW)
        const outside = yield* outcomeOf(policy, {
          ...EDIT,
          locations: [{ path: `${CWD}/a.ts` }, { path: "/srv/other/x.ts" }],
        })
        expect(outside.outcome).toEqual(CANCELLED)
        expect(outside.events.at(-1)).toMatchObject({
          kind: "approval_needed",
          action: { tool: "Edit", resource: "/srv/other/x.ts" },
        })
        const secret = yield* outcomeOf(policy, {
          ...EDIT,
          locations: [{ path: "/srv/other/x.ts" }, { path: `${CWD}/.env` }],
        })
        expect(secret.outcome).toEqual(REJECT)
        expect(spy).toHaveLength(6)
      }),
    ),
  )

  it.effect("paths named only by a diff are judged too", () =>
    withRealPolicy((policy) =>
      Effect.gen(function* () {
        const { outcome } = yield* outcomeOf(policy, {
          toolCallId: "d",
          kind: "edit",
          title: "edit",
          content: [{ type: "diff", path: `${CWD}/.env`, newText: "X=1" }],
        })
        expect(outcome).toEqual(REJECT)
      }),
    ),
  )

  it.effect("a move needs a source and a destination, otherwise it asks", () =>
    withRealPolicy((policy) =>
      Effect.gen(function* () {
        const lone = yield* outcomeOf(policy, {
          toolCallId: "m",
          kind: "move",
          title: "mv",
          locations: [{ path: `${CWD}/a` }],
        })
        expect(lone.outcome).toEqual(CANCELLED)
        const both = yield* outcomeOf(policy, {
          toolCallId: "m",
          kind: "move",
          title: "mv",
          locations: [{ path: `${CWD}/a` }],
          rawInput: { destination: `${CWD}/b` },
        })
        expect(both.outcome).toEqual(ALLOW)
        const out = yield* outcomeOf(policy, {
          toolCallId: "m",
          kind: "move",
          title: "mv",
          locations: [{ path: `${CWD}/a` }],
          rawInput: { destination: "/etc/passwd" },
        })
        expect(out.outcome).toEqual(REJECT)
      }),
    ),
  )
})
