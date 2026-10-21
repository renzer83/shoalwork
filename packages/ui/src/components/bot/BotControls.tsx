import type { BotState } from "@shoalwork/contracts"
import { View } from "react-native"
import { Button, HelperText, Text } from "react-native-paper"
import type { BotControl, ControlAction } from "../../hooks/useBotControl.js"
import { useLocale } from "../../i18n/index.js"

export interface BotControlsProps {
  readonly state: BotState
  readonly control: BotControl
}

// Pause while the Bot runs, resume once it is paused. The label follows the state, which the live feed keeps current.
export function BotControls({ state, control }: BotControlsProps) {
  const { t } = useLocale()
  const paused = state === "paused"
  const archived = state === "archived"
  const action: ControlAction = paused ? "resume" : "pause"
  const waiting = state === "waiting_approval" || state === "blocked"
  return (
    <View style={{ gap: 6 }}>
      <Button
        mode="outlined"
        disabled={control.pending !== null || archived}
        onPress={() => control.run(action)}
      >
        {paused ? t("bot.resume") : t("bot.pause")}
      </Button>
      {waiting && !paused ? <Text variant="bodySmall">{t("bot.keepsState")}</Text> : null}
      {control.failure === null ? null : (
        <HelperText type="error">
          {control.failure.action === "pause"
            ? t("bot.pauseFailed", { status: control.failure.status })
            : t("bot.resumeFailed", { status: control.failure.status })}
        </HelperText>
      )}
    </View>
  )
}
