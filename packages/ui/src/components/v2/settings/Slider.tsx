import { useRef, useState } from "react"
import { type LayoutChangeEvent, View } from "react-native"
import { tokens } from "../../../theme.js"

export interface SliderProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly onChange: (value: number) => void
  readonly label: string
  // Read out as the value ("64K").
  readonly valueText: string
}

const TRACK = 6
const THUMB = 18

const snap = (raw: number, min: number, max: number, step: number): number =>
  Math.min(max, Math.max(min, Math.round(raw / step) * step))

// A horizontal slider: click or drag on the track, arrow keys when it has the focus. The children of the track
// ignore the pointer so every touch is measured against the track itself.
export function Slider({ value, min, max, step, onChange, label, valueText }: SliderProps) {
  const [width, setWidth] = useState(0)
  const dragging = useRef(false)
  const ratio = (value - min) / (max - min)

  const fromX = (x: number) => {
    if (width <= 0) return
    onChange(snap(min + (Math.min(Math.max(x, 0), width) / width) * (max - min), min, max, step))
  }

  return (
    <View
      role="slider"
      tabIndex={0}
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: valueText }}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(event) => {
        dragging.current = true
        fromX(event.nativeEvent.locationX)
      }}
      onResponderMove={(event) => {
        if (dragging.current) fromX(event.nativeEvent.locationX)
      }}
      onResponderRelease={() => {
        dragging.current = false
      }}
      onResponderTerminate={() => {
        dragging.current = false
      }}
      onKeyDown={(event) => {
        const key = event.nativeEvent.key
        if (key === "ArrowRight" || key === "ArrowUp") onChange(snap(value + step, min, max, step))
        else if (key === "ArrowLeft" || key === "ArrowDown") onChange(snap(value - step, min, max, step))
        else if (key === "Home") onChange(min)
        else if (key === "End") onChange(max)
      }}
      style={{ height: 28, justifyContent: "center", flex: 1 }}
    >
      <View
        pointerEvents="none"
        style={{ height: TRACK, borderRadius: TRACK / 2, backgroundColor: tokens.color.elevated }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: TRACK,
            borderRadius: TRACK / 2,
            backgroundColor: tokens.color.accent,
          }}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: Math.max(0, ratio * (width - THUMB)),
          width: THUMB,
          height: THUMB,
          borderRadius: THUMB / 2,
          backgroundColor: tokens.color.accent,
          borderWidth: 3,
          borderColor: tokens.color.link,
        }}
      />
    </View>
  )
}
