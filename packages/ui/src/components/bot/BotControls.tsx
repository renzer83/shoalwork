import type { BotState } from "@shoalwork/contracts"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { BotControl, ControlAction } from "../../hooks/useBotControl.js"

export interface BotControlsProps {
  readonly state: BotState
  readonly control: BotControl
}

// Pause while the Bot runs, resume once it is paused. The label follows the state, which the live feed keeps current.
export function BotControls({ state, control }: BotControlsProps) {
  const paused = state === "paused"
  const action: ControlAction = paused ? "resume" : "pause"
  const waiting = state === "waiting_approval" || state === "blocked"
  return (
    <View style={{ gap: 6 }}>
      <Button mode="outlined" disabled={control.pending !== null} onPress={() => control.run(action)}>
        {paused ? "Resume" : "Pause"}
      </Button>
      {waiting && !paused ? (
        <Text variant="bodySmall">The Bot keeps this state; a pause only stops new work from starting.</Text>
      ) : null}
      {control.failure === null ? null : (
        <HelperText type="error">{`${control.failure.action} failed (HTTP ${control.failure.status})`}</HelperText>
      )}
    </View>
  )
}
