import type { BotState } from "@shoalwork/contracts"
import { stateColor } from "../components/v2/StatusDot.js"
import type { MessageKey, Translate } from "../i18n/index.js"

const LABEL: Readonly<Record<BotState, MessageKey>> = {
  idle: "shell.state.online",
  done: "shell.state.online",
  thinking: "shell.state.working",
  working: "shell.state.working",
  waiting_approval: "shell.state.waiting",
  blocked: "shell.state.blocked",
  paused: "shell.state.paused",
  archived: "shell.state.archived",
}

export interface BotStatus {
  readonly color: string
  readonly label: string
}

export const botStatus = (state: BotState | undefined, t: Translate): BotStatus =>
  state === undefined
    ? { color: stateColor("paused"), label: t("shell.state.unknown") }
    : { color: stateColor(state), label: t(LABEL[state]) }
