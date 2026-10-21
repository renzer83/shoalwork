import { Effect } from "effect"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text, TextInput } from "react-native-paper"
import { useApi } from "../../api-context.js"
import { failureText } from "../../hooks/failure.js"
import { type MessageKey, useLocale } from "../../i18n/index.js"
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
  const { t } = useLocale()
  const [draft, setDraft] = useState<TideDraft>(EMPTY_TIDE_DRAFT)
  const [issues, setIssues] = useState<ReadonlyArray<MessageKey>>([])
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
      setFailure(failureText(result.failure, t))
      return
    }
    setDraft(EMPTY_TIDE_DRAFT)
    onSaved()
  }

  return (
    <View style={{ gap: 8 }}>
      <Text variant="titleSmall">{t("tides.form.title")}</Text>
      <TextInput
        testID="tide-bot"
        label={t("tides.form.bot")}
        value={draft.bot}
        onChangeText={(bot) => set({ bot })}
      />
      <TextInput
        testID="tide-name"
        label={t("common.name")}
        value={draft.name}
        onChangeText={(name) => set({ name })}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button mode={draft.mode === "cron" ? "contained" : "outlined"} onPress={() => set({ mode: "cron" })}>
          {t("tides.form.onSchedule")}
        </Button>
        <Button
          mode={draft.mode === "event" ? "contained" : "outlined"}
          onPress={() => set({ mode: "event" })}
        >
          {t("tides.form.onEvent")}
        </Button>
      </View>
      {draft.mode === "cron" ? (
        <TextInput
          testID="tide-cron"
          label={t("tides.form.cron")}
          value={draft.cronExpr}
          onChangeText={(cronExpr) => set({ cronExpr })}
        />
      ) : (
        <TextInput
          testID="tide-event"
          label={t("tides.form.eventType")}
          value={draft.eventType}
          onChangeText={(eventType) => set({ eventType })}
        />
      )}
      <TextInput
        testID="tide-title"
        label={t("tides.form.taskTitle")}
        value={draft.title}
        onChangeText={(title) => set({ title })}
      />
      <TextInput
        testID="tide-prompt"
        label={t("tides.form.taskPrompt")}
        multiline
        value={draft.prompt}
        onChangeText={(prompt) => set({ prompt })}
      />
      {issues.map((issue) => (
        <HelperText key={issue} type="error" visible>
          {t(issue)}
        </HelperText>
      ))}
      {failure === null ? null : (
        <HelperText type="error" visible>
          {t("tides.form.failed", { failure })}
        </HelperText>
      )}
      <Button mode="contained" onPress={() => void submit()} disabled={busy}>
        {t("tides.form.save")}
      </Button>
    </View>
  )
}
