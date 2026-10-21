import { Effect } from "effect"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text, TextInput } from "react-native-paper"
import { useApi } from "../../api-context.js"
import { failureText } from "../../hooks/failure.js"
import { type MessageKey, useLocale } from "../../i18n/index.js"
import { type McpDraft, mcpDraftBody, mcpDraftIssues, ServerAdded } from "./currents-model.js"

export interface McpFormProps {
  // Called after the core stored the server: the catalog reloads.
  readonly onSaved: () => void
}

const EMPTY: McpDraft = { name: "", transport: "stdio", command: "", args: "", url: "", envKeys: "" }

// Adds an MCP server to the registry (POST /connectors/mcp). Env entries are Vault key names only: the form refuses
// anything else before it sends, and the core checks again.
export function McpForm({ onSaved }: McpFormProps) {
  const { client } = useApi()
  const { t } = useLocale()
  const [draft, setDraft] = useState<McpDraft>(EMPTY)
  const [issues, setIssues] = useState<ReadonlyArray<MessageKey>>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }))

  const submit = async () => {
    const found = mcpDraftIssues(draft)
    setIssues(found)
    setFailure(null)
    if (found.length > 0) return
    setBusy(true)
    const result = await Effect.runPromise(
      Effect.result(client.post("/connectors/mcp", mcpDraftBody(draft), ServerAdded)),
    )
    setBusy(false)
    if (result._tag === "Failure") {
      setFailure(failureText(result.failure, t))
      return
    }
    setDraft(EMPTY)
    onSaved()
  }

  return (
    <View style={{ gap: 8 }}>
      <Text variant="titleSmall">{t("mcp.title")}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          mode={draft.transport === "stdio" ? "contained" : "outlined"}
          onPress={() => set({ transport: "stdio" })}
        >
          {t("mcp.local")}
        </Button>
        <Button
          mode={draft.transport === "http" ? "contained" : "outlined"}
          onPress={() => set({ transport: "http" })}
        >
          {t("mcp.remote")}
        </Button>
      </View>
      <TextInput
        testID="mcp-name"
        label={t("common.name")}
        value={draft.name}
        onChangeText={(name) => set({ name })}
      />
      {draft.transport === "stdio" ? (
        <>
          <TextInput
            testID="mcp-command"
            label={t("mcp.command")}
            value={draft.command}
            onChangeText={(command) => set({ command })}
          />
          <TextInput
            testID="mcp-args"
            label={t("mcp.args")}
            value={draft.args}
            onChangeText={(args) => set({ args })}
          />
          <TextInput
            testID="mcp-env-keys"
            label={t("mcp.envKeys")}
            value={draft.envKeys}
            onChangeText={(envKeys) => set({ envKeys })}
          />
        </>
      ) : (
        <TextInput
          testID="mcp-url"
          label={t("mcp.url")}
          value={draft.url}
          onChangeText={(url) => set({ url })}
        />
      )}
      {issues.map((issue) => (
        <HelperText key={issue} type="error" visible>
          {t(issue)}
        </HelperText>
      ))}
      {failure === null ? null : (
        <HelperText type="error" visible>
          {t("mcp.failed", { failure })}
        </HelperText>
      )}
      <Button mode="contained" onPress={() => void submit()} disabled={busy}>
        {t("mcp.add")}
      </Button>
    </View>
  )
}
