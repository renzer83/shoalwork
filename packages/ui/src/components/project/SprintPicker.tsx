import type { NewSprintBody, SprintView } from "@shoalwork/api-client"
import { useState } from "react"
import { TextInput, View } from "react-native"
import { Button, Card, Text } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import type { SprintFilter } from "./project-model.js"

const DAY_MS = 86_400_000

export interface SprintPickerProps {
  readonly sprints: ReadonlyArray<SprintView>
  readonly filter: SprintFilter
  readonly onSelect: (filter: SprintFilter) => void
  readonly onCreate: (sprint: NewSprintBody) => void
}

// Choose the sprint the board shows, or create a new one (dates as ISO-8601 instants).
export function SprintPicker({ sprints, filter, onSelect, onCreate }: SprintPickerProps) {
  const { t } = useLocale()
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [startsAt, setStartsAt] = useState(() => new Date().toISOString())
  const [endsAt, setEndsAt] = useState(() => new Date(Date.now() + 14 * DAY_MS).toISOString())

  const chip = (label: string, active: boolean, onPress: () => void) => (
    <Button key={label} compact mode={active ? "contained" : "outlined"} onPress={onPress}>
      {label}
    </Button>
  )

  return (
    <Card>
      <Card.Content style={{ gap: 8 }}>
        <Text variant="titleSmall">{t("sprint.title")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {chip(t("sprint.all"), filter.kind === "all", () => onSelect({ kind: "all" }))}
          {chip(t("board.noSprint"), filter.kind === "none", () => onSelect({ kind: "none" }))}
          {sprints.map((s) =>
            chip(s.name, filter.kind === "sprint" && filter.id === s.id, () =>
              onSelect({ kind: "sprint", id: s.id }),
            ),
          )}
        </View>
        <TextInput
          accessibilityLabel={t("sprint.name")}
          placeholder={t("sprint.nameField")}
          value={name}
          onChangeText={setName}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel={t("sprint.start")}
          value={startsAt}
          onChangeText={setStartsAt}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel={t("sprint.end")}
          value={endsAt}
          onChangeText={setEndsAt}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel={t("sprint.goal")}
          placeholder={t("sprint.goalField")}
          value={goal}
          onChangeText={setGoal}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <Button
          mode="contained"
          disabled={name.trim() === ""}
          onPress={() => {
            onCreate({ name: name.trim(), startsAt, endsAt, goal })
            setName("")
            setGoal("")
          }}
        >
          {t("sprint.create")}
        </Button>
      </Card.Content>
    </Card>
  )
}
