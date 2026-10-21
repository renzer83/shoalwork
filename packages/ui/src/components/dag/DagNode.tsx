import type { StepState } from "@shoalwork/api-client"
import { useTheme } from "react-native-paper"
import { G, Rect, Text as SvgText } from "react-native-svg"
import { NODE_HEIGHT, NODE_WIDTH } from "./dag-layout.js"
import { STATE_LABEL, type StepTone, toneOf } from "./step-tone.js"

export interface DagNodeProps {
  readonly x: number
  readonly y: number
  readonly title: string
  readonly state: StepState
  readonly costUsd: number
}

const TITLE_MAX = 22

// Step text is data: it is clipped and drawn as text, never parsed.
const clipTitle = (title: string): string =>
  title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title

const money = (usd: number): string => `US$ ${usd.toFixed(2)}`

export function DagNode({ x, y, title, state, costUsd }: DagNodeProps) {
  const theme = useTheme()
  const colours: Record<StepTone, string> = {
    done: theme.colors.primary,
    active: theme.colors.tertiary,
    waiting: theme.colors.secondary,
    failed: theme.colors.error,
    idle: theme.colors.outline,
  }
  return (
    <G>
      <Rect
        x={x}
        y={y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={10}
        fill={theme.colors.surfaceVariant}
        stroke={colours[toneOf(state)]}
        strokeWidth={2}
      />
      <SvgText x={x + 12} y={y + 22} fontSize={13} fill={theme.colors.onSurface}>
        {clipTitle(title)}
      </SvgText>
      <SvgText x={x + 12} y={y + 42} fontSize={11} fill={theme.colors.outline}>
        {`${STATE_LABEL[state]} · ${money(costUsd)}`}
      </SvgText>
    </G>
  )
}
