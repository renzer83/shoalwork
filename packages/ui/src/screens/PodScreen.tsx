import { type PodDetail, pauseBot, stopPod } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { MessageBubble } from "../components/chat/MessageBubble.js"
import { DagView } from "../components/dag/DagView.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { usePod } from "../hooks/usePod.js"
import { clock, money } from "./pod-format.js"

export interface PodScreenProps {
  readonly id: string
}

// Runs one action and reports a failure as text; the Pod is refetched afterwards either way.
const runAction = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.result(effect)).then((result) =>
    result._tag === "Success" ? undefined : "The action failed; the core did not accept it",
  )

// One Pod: the plan as a graph, the Pod's messages, and the stop and pause actions. Editing the plan is out of scope.
export function PodScreen({ id }: PodScreenProps) {
  const theme = useTheme()
  const { client } = useApi()
  const { load, reload } = usePod(id)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const act = (effect: Effect.Effect<unknown, unknown>) => {
    setBusy(true)
    void runAction(effect).then((error) => {
      setBusy(false)
      setActionError(error)
      reload()
    })
  }

  const detail: PodDetail | undefined = load.kind === "loaded" ? load.detail : undefined
  const titleOf = (stepId: string | null): string =>
    detail?.steps.find((step) => step.id === stepId)?.title ?? "plan"
  const bots = detail === undefined ? [] : [...new Set(detail.steps.flatMap((step) => step.botId ?? []))]

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={detail?.pod.name ?? "Time"} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={`Could not load the Pod (HTTP ${load.status})`} onRetry={reload} />
        ) : null}
        {actionError === undefined ? null : <ErrorBanner message={actionError} />}
        {detail === undefined ? null : (
          <>
            <Text variant="bodyMedium">
              {`${detail.pod.state} · ${detail.steps.filter((step) => step.state === "done").length}/${detail.steps.length} steps · ${money(detail.steps.reduce((sum, step) => sum + step.usage.usd, 0))}`}
            </Text>
            <DagView
              steps={detail.steps.map((step) => ({
                id: step.id,
                title: step.title,
                state: step.state,
                costUsd: step.usage.usd,
                dependsOn: step.dependsOn,
              }))}
            />
            <View style={{ gap: 8 }}>
              <Text variant="titleSmall">Messages</Text>
              {detail.messages.length === 0 ? <Text variant="bodySmall">No messages yet.</Text> : null}
              {detail.messages.map((message) => (
                <MessageBubble
                  key={message.position}
                  direction="out"
                  text={message.text}
                  time={clock(message.occurredAt)}
                  channel={`${message.kind} · ${titleOf(message.stepId)}`}
                />
              ))}
            </View>
            <View style={{ gap: 8 }}>
              <Button
                mode="outlined"
                disabled={busy || detail.pod.state !== "open"}
                onPress={() => act(stopPod(client, detail.pod.taskId))}
              >
                Stop Pod
              </Button>
              {bots.map((botId) => (
                <Button key={botId} mode="text" disabled={busy} onPress={() => act(pauseBot(client, botId))}>
                  {`Pause ${botId}`}
                </Button>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  )
}
