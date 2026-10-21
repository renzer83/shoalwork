import { Effect } from "effect"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text, TextInput } from "react-native-paper"
import { useApi } from "../../api-context.js"
import { failureText } from "../../hooks/failure.js"
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
  const [draft, setDraft] = useState<McpDraft>(EMPTY)
  const [issues, setIssues] = useState<ReadonlyArray<string>>([])
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
      setFailure(failureText(result.failure))
      return
    }
    setDraft(EMPTY)
    onSaved()
  }

  return (
    <View style={{ gap: 8 }}>
      <Text variant="titleSmall">Add an MCP server</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button
          mode={draft.transport === "stdio" ? "contained" : "outlined"}
          onPress={() => set({ transport: "stdio" })}
        >
          Local (stdio)
        </Button>
        <Button
          mode={draft.transport === "http" ? "contained" : "outlined"}
          onPress={() => set({ transport: "http" })}
        >
          Remote (https)
        </Button>
      </View>
      <TextInput testID="mcp-name" label="Name" value={draft.name} onChangeText={(name) => set({ name })} />
      {draft.transport === "stdio" ? (
        <>
          <TextInput
            testID="mcp-command"
            label="Command"
            value={draft.command}
            onChangeText={(command) => set({ command })}
          />
          <TextInput
            testID="mcp-args"
            label="Arguments"
            value={draft.args}
            onChangeText={(args) => set({ args })}
          />
          <TextInput
            testID="mcp-env-keys"
            label="Vault key names (env), e.g. GITHUB_TOKEN"
            value={draft.envKeys}
            onChangeText={(envKeys) => set({ envKeys })}
          />
        </>
      ) : (
        <TextInput testID="mcp-url" label="URL" value={draft.url} onChangeText={(url) => set({ url })} />
      )}
      {issues.map((issue) => (
        <HelperText key={issue} type="error" visible>
          {issue}
        </HelperText>
      ))}
      {failure === null ? null : (
        <HelperText type="error" visible>
          {`Could not add the server (${failure})`}
        </HelperText>
      )}
      <Button mode="contained" onPress={() => void submit()} disabled={busy}>
        Add server
      </Button>
    </View>
  )
}
