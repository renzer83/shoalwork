import { View } from "react-native"
import { Path, Rect, Svg } from "react-native-svg"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import type { ExecutorFamily } from "./executor-catalog.js"

export interface ExecutorIconProps {
  readonly family: ExecutorFamily
  readonly size?: number
}

const ORANGE = tokens.color.orange
const CENTER = 24

// Twelve spokes of the Claude mark, each a short line from an inner to an outer radius.
const SPOKES = Array.from({ length: 12 }, (_, index) => {
  const angle = (index * Math.PI) / 6
  const point = (radius: number) =>
    `${(CENTER + radius * Math.cos(angle)).toFixed(1)} ${(CENTER + radius * Math.sin(angle)).toFixed(1)}`
  return `M${point(6)}L${point(15)}`
})

// Simplified marks of each CLI on a dark tile: recognisable, not a reproduction of the logos.
function Glyph({ family }: { readonly family: Exclude<ExecutorFamily, "other"> }) {
  switch (family) {
    case "claude":
      return (
        <>
          {SPOKES.map((d) => (
            <Path key={d} d={d} stroke={ORANGE} strokeWidth={3} strokeLinecap="round" />
          ))}
        </>
      )
    case "codex":
      return (
        <>
          <Rect x={8} y={8} width={32} height={32} rx={9} fill="#1A8CFF" />
          <Path
            d="M31 18a9 9 0 1 0 0 12"
            stroke={tokens.color.white}
            strokeWidth={4}
            strokeLinecap="round"
            fill="none"
          />
        </>
      )
    case "gemini":
      return (
        <>
          <Path d="M32.4 16.9A11 11 0 0 0 15.6 16.9" stroke="#EA4335" strokeWidth={4.5} fill="none" />
          <Path d="M15.6 16.9A11 11 0 0 0 15.6 31.1" stroke="#FBBC05" strokeWidth={4.5} fill="none" />
          <Path d="M15.6 31.1A11 11 0 0 0 32.4 31.1" stroke="#34A853" strokeWidth={4.5} fill="none" />
          <Path d="M32.4 31.1A11 11 0 0 0 35 24H24" stroke="#4285F4" strokeWidth={4.5} fill="none" />
        </>
      )
    case "ollama":
      return (
        <>
          <Path d="M17 13v7M31 13v7" stroke="#101626" strokeWidth={3} strokeLinecap="round" />
          <Path d="M16 21a8 8 0 0 1 16 0v7a8 8 0 0 1-16 0z" stroke="#101626" strokeWidth={2.5} fill="none" />
          <Path d="M21 24h.01M27 24h.01" stroke="#101626" strokeWidth={3} strokeLinecap="round" />
          <Path d="M22 30c1 1 3 1 4 0" stroke="#101626" strokeWidth={2} strokeLinecap="round" fill="none" />
        </>
      )
  }
}

// The tile of an executor: its mark centred on a dark rounded square (white for Ollama, as in the reference).
export function ExecutorIcon({ family, size = 48 }: ExecutorIconProps) {
  const light = family === "ollama"
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        borderWidth: 1,
        borderColor: tokens.color.border,
        backgroundColor: light ? "#F4F6FA" : "#0D1322",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {family === "other" ? (
        <Icon name="terminal" size={Math.round(size * 0.5)} color={tokens.color.textSecondary} />
      ) : (
        <Svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
          <Glyph family={family} />
        </Svg>
      )}
    </View>
  )
}
