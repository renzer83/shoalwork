import { Effect } from "effect"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text, TextInput } from "react-native-paper"
import { useApi } from "../../api-context.js"
import { failureText } from "../../hooks/failure.js"
import {
  EMPTY_TIDE_DRAFT,
  TideCreated,
  type TideDraft,
  tideDraftBody,
  tideDraftIssues,
} from "./tide-model.js"

export interface TideFormProps {
  // Called after the core stored the Tide: the list reloads.
  readonly onSaved: () => void
}

// Creates a Tide (POST /tides) on a cron schedule or on an event. The core validates the cron expression and names the
// one it refuses; that message is shown as it comes.
export function TideForm({ onSaved }: TideFormProps) {
  const { client } = useApi()
  const [draft, setDraft] = useState<TideDraft>(EMPTY_TIDE_DRAFT)
  const [issues, setIssues] = useState<ReadonlyArray<string>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<TideDraft>) => setDraft((current) => ({ ...current, ...patch }))

  const submit = async () => {
    const found = tideDraftIssues(draft)
    setIssues(found)
    setFailure(null)
    if (found.length > 0) return
    setBusy(true)
    const result = await Effect.runPromise(
      Effect.result(client.post("/tides", tideDraftBody(draft), TideCreated)),
    )
    setBusy(false)
    if (result._tag === "Failure") {
      setFailure(failureText(result.failure))
      return
    }
    setDraft(EMPTY_TIDE_DRAFT)
    onSaved()
  }

  return (
    <View style={{ gap: 8 }}>
      <Text variant="titleSmall">New Tide</Text>
      <TextInput
        testID="tide-bot"
        label="Bot (name)"
        value={draft.bot}
        onChangeText={(bot) => set({ bot })}
      />
      <TextInput testID="tide-name" label="Name" value={draft.name} onChangeText={(name) => set({ name })} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button mode={draft.mode === "cron" ? "contained" : "outlined"} onPress={() => set({ mode: "cron" })}>
          On a schedule
        </Button>
        <Button
          mode={draft.mode === "event" ? "contained" : "outlined"}
          onPress={() => set({ mode: "event" })}
        >
          On an event
        </Button>
      </View>
      {draft.mode === "cron" ? (
        <TextInput
          testID="tide-cron"
          label="Cron expression (UTC), e.g. 0 9 * * 1-5"
          value={draft.cronExpr}
          onChangeText={(cronExpr) => set({ cronExpr })}
        />
      ) : (
        <TextInput
          testID="tide-event"
          label="Event type, e.g. github.issues"
          value={draft.eventType}
          onChangeText={(eventType) => set({ eventType })}
        />
      )}
      <TextInput
        testID="tide-title"
        label="Task title"
        value={draft.title}
        onChangeText={(title) => set({ title })}
      />
      <TextInput
        testID="tide-prompt"
        label="Task prompt"
        multiline
        value={draft.prompt}
        onChangeText={(prompt) => set({ prompt })}
      />
      {issues.map((issue) => (
        <HelperText key={issue} type="error" visible>
          {issue}
        </HelperText>
      ))}
      {failure === null ? null : (
        <HelperText type="error" visible>
          {`Could not save the Tide (${failure})`}
        </HelperText>
      )}
      <Button mode="contained" onPress={() => void submit()} disabled={busy}>
        Save Tide
      </Button>
    </View>
  )
}
