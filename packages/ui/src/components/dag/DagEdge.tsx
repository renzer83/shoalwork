import { useTheme } from "react-native-paper"
import { Path } from "react-native-svg"

export interface DagEdgeProps {
  // The SVG path data (see edgePath in dag-layout.ts).
  readonly d: string
}

export function DagEdge({ d }: DagEdgeProps) {
  const theme = useTheme()
  return <Path d={d} stroke={theme.colors.outline} strokeWidth={1.5} fill="none" />
}
