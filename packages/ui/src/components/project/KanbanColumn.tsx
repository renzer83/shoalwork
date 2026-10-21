import type { BoardTask, SprintView } from "@shoalwork/api-client"
import type { ProjectTaskState } from "@shoalwork/contracts"
import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { TaskCard } from "./TaskCard.js"

export interface KanbanColumnActions {
  readonly move: (taskId: string, to: ProjectTaskState) => void
  readonly retry: (taskId: string) => void
  readonly pause: (taskId: string) => void
  readonly sprint: (taskId: string, sprintId: string | null) => void
}

export interface KanbanColumnProps {
  readonly state: ProjectTaskState
  readonly tasks: ReadonlyArray<BoardTask>
  readonly sprints: ReadonlyArray<SprintView>
  readonly repoUrl: string
  readonly now: number
  readonly wide: boolean
  readonly actions: KanbanColumnActions
}

// One state of the board: its header and the cards in it.
export function KanbanColumn({ state, tasks, sprints, repoUrl, now, wide, actions }: KanbanColumnProps) {
  const theme = useTheme()
  return (
    <View
      accessibilityLabel={`column ${state}`}
      style={{
        width: wide ? undefined : 260,
        flex: wide ? 1 : undefined,
        minWidth: wide ? 160 : undefined,
        gap: 8,
        padding: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceVariant,
      }}
    >
      <Text variant="titleSmall">{`${state} (${tasks.length})`}</Text>
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          sprints={sprints}
          repoUrl={repoUrl}
          now={now}
          onMove={(to) => actions.move(task.id, to)}
          onRetry={() => actions.retry(task.id)}
          onPause={() => actions.pause(task.id)}
          onSprint={(sprintId) => actions.sprint(task.id, sprintId)}
        />
      ))}
    </View>
  )
}
