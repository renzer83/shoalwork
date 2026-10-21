import type { NewSprintBody, SprintView } from "@shoalwork/api-client"
import { useState } from "react"
import { TextInput, View } from "react-native"
import { Button, Card, Text } from "react-native-paper"
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
        <Text variant="titleSmall">Sprint</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {chip("All", filter.kind === "all", () => onSelect({ kind: "all" }))}
          {chip("No sprint", filter.kind === "none", () => onSelect({ kind: "none" }))}
          {sprints.map((s) =>
            chip(s.name, filter.kind === "sprint" && filter.id === s.id, () =>
              onSelect({ kind: "sprint", id: s.id }),
            ),
          )}
        </View>
        <TextInput
          accessibilityLabel="Sprint name"
          placeholder="Name"
          value={name}
          onChangeText={setName}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel="Sprint start"
          value={startsAt}
          onChangeText={setStartsAt}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel="Sprint end"
          value={endsAt}
          onChangeText={setEndsAt}
          style={{ borderWidth: 1, borderRadius: 6, padding: 8 }}
        />
        <TextInput
          accessibilityLabel="Sprint goal"
          placeholder="Goal"
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
          Create sprint
        </Button>
      </Card.Content>
    </Card>
  )
}
