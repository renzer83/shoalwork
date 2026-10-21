import type { BoardTask, SprintView } from "@shoalwork/api-client"
import type { ProjectTaskState } from "@shoalwork/contracts"
import { useState } from "react"
import { Linking, View } from "react-native"
import { Button, Card, Text } from "react-native-paper"
import { ageText, COLUMNS, githubLinkOf } from "./project-model.js"

export interface TaskCardProps {
  readonly task: BoardTask
  readonly sprints: ReadonlyArray<SprintView>
  readonly repoUrl: string
  readonly now: number
  readonly onMove: (to: ProjectTaskState) => void
  readonly onRetry: () => void
  readonly onPause: () => void
  readonly onSprint: (sprintId: string | null) => void
}

// One task on the board. Text from the task (title, branch) is rendered as text only.
export function TaskCard({ task, sprints, repoUrl, now, onMove, onRetry, onPause, onSprint }: TaskCardProps) {
  const [open, setOpen] = useState<"move" | "sprint" | null>(null)
  const sprint = sprints.find((s) => s.id === task.sprintId)
  const link = githubLinkOf(repoUrl, task)
  const refs = [
    task.issueNumber === null ? null : `#${task.issueNumber}`,
    task.prNumber === null ? null : `PR #${task.prNumber}`,
  ].filter((ref): ref is string => ref !== null)

  return (
    <Card>
      <Card.Content style={{ gap: 4 }}>
        <Text variant="titleSmall">{task.title}</Text>
        <Text variant="bodySmall">{refs.length === 0 ? "no issue" : refs.join(" · ")}</Text>
        <Text variant="labelSmall">{`in state ${ageText(task.updatedAt, now)} · retries ${task.retries}`}</Text>
        <Text variant="labelSmall">{`sprint: ${sprint?.name ?? "none"}`}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          <Button compact onPress={() => setOpen(open === "move" ? null : "move")}>
            Move
          </Button>
          <Button compact onPress={onRetry}>
            Retry
          </Button>
          <Button compact onPress={onPause}>
            Pause
          </Button>
          <Button compact onPress={() => setOpen(open === "sprint" ? null : "sprint")}>
            Sprint
          </Button>
          {link === undefined ? null : (
            <Button compact onPress={() => void Linking.openURL(link)}>
              GitHub
            </Button>
          )}
        </View>
        {open === "move" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {COLUMNS.filter((state) => state !== task.state).map((state) => (
              <Button
                key={state}
                compact
                mode="outlined"
                onPress={() => {
                  setOpen(null)
                  onMove(state)
                }}
              >
                {state}
              </Button>
            ))}
          </View>
        ) : null}
        {open === "sprint" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            <Button
              compact
              mode="outlined"
              onPress={() => {
                setOpen(null)
                onSprint(null)
              }}
            >
              No sprint
            </Button>
            {sprints.map((s) => (
              <Button
                key={s.id}
                compact
                mode="outlined"
                onPress={() => {
                  setOpen(null)
                  onSprint(s.id)
                }}
              >
                {s.name}
              </Button>
            ))}
          </View>
        ) : null}
      </Card.Content>
    </Card>
  )
}
