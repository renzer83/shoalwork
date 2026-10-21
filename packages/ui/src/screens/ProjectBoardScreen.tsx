import { useState } from "react"
import { ActivityIndicator, ScrollView, useWindowDimensions, View } from "react-native"
import { useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { KanbanColumn } from "../components/project/KanbanColumn.js"
import { MetricsPanel } from "../components/project/MetricsPanel.js"
import { COLUMNS, inSprint, type SprintFilter } from "../components/project/project-model.js"
import { SprintPicker } from "../components/project/SprintPicker.js"
import { useBoard } from "../hooks/useBoard.js"
import { useProjectMetrics } from "../hooks/useProjects.js"
import { useLocale } from "../i18n/index.js"

// From this width every column is visible at once; below it the columns scroll sideways.
const WIDE_MIN_WIDTH = 900

export interface ProjectBoardScreenProps {
  readonly slug: string
}

// The kanban of one project: metrics against the baseline, sprints, and one column per state of T-060.
export function ProjectBoardScreen({ slug }: ProjectBoardScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { width } = useWindowDimensions()
  const board = useBoard(slug)
  const metrics = useProjectMetrics(slug)
  const [filter, setFilter] = useState<SprintFilter>({ kind: "all" })
  const wide = width >= WIDE_MIN_WIDTH
  const now = Date.now()

  const body =
    board.load.kind === "loaded" ? (
      <>
        <SprintPicker
          sprints={board.load.sprints}
          filter={filter}
          onSelect={setFilter}
          onCreate={board.createSprint}
        />
        {board.notice === null ? null : <ErrorBanner message={board.notice} />}
        {(() => {
          const visible = board.load.tasks.filter((task) => inSprint(task, filter))
          const columns = COLUMNS.map((state) => (
            <KanbanColumn
              key={state}
              state={state}
              tasks={visible.filter((task) => task.state === state)}
              sprints={board.load.kind === "loaded" ? board.load.sprints : []}
              repoUrl={board.load.kind === "loaded" ? board.load.repoUrl : ""}
              now={now}
              wide={wide}
              actions={{
                move: (taskId, to) => board.patch(taskId, { move: { to } }),
                retry: (taskId) => board.patch(taskId, { retry: true }),
                pause: (taskId) => board.patch(taskId, { pause: true }),
                sprint: (taskId, sprintId) => board.patch(taskId, { sprintId }),
              }}
            />
          ))
          return wide ? (
            <View style={{ flexDirection: "row", gap: 8 }}>{columns}</View>
          ) : (
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {columns}
            </ScrollView>
          )
        })()}
      </>
    ) : null

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar
        title={slug}
        onRefresh={() => {
          board.reload()
          metrics.reload()
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {board.load.kind === "loading" ? (
          <ActivityIndicator accessibilityLabel={t("common.loading")} />
        ) : null}
        {board.load.kind === "failed" ? (
          <ErrorBanner
            message={t("board.loadFailed", { status: board.load.status })}
            onRetry={board.reload}
          />
        ) : null}
        <MetricsPanel load={metrics.load} onRetry={metrics.reload} />
        {body}
      </ScrollView>
    </View>
  )
}
