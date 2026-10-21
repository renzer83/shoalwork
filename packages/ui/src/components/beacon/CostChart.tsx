import { View } from "react-native"
import { Text, useTheme } from "react-native-paper"
import { Rect, Svg } from "react-native-svg"
import { useLocale } from "../../i18n/index.js"

export interface CostBar {
  readonly label: string
  readonly value: number
}

const BAR_SLOT = 10
const BAR_WIDTH = 8

// One bar per entry, scaled to the largest value. Plain SVG rectangles: no charting library.
export function CostChart({
  title,
  bars,
  height = 120,
}: {
  readonly title: string
  readonly bars: ReadonlyArray<CostBar>
  readonly height?: number
}) {
  const theme = useTheme()
  const { t } = useLocale()
  const max = Math.max(0, ...bars.map((bar) => bar.value))
  const drawable = height - 4
  return (
    <View accessibilityLabel={t("beacon.cost.chartA11y", { title, count: bars.length })} style={{ gap: 4 }}>
      <Svg
        width="100%"
        height={height}
        viewBox={`0 0 ${Math.max(bars.length, 1) * BAR_SLOT} ${height}`}
        preserveAspectRatio="none"
      >
        {bars.map((bar, index) => {
          const barHeight = max === 0 ? 0 : (bar.value / max) * drawable
          return (
            <Rect
              key={`${bar.label}-${index}`}
              x={index * BAR_SLOT + (BAR_SLOT - BAR_WIDTH) / 2}
              y={height - barHeight}
              width={BAR_WIDTH}
              height={barHeight}
              fill={theme.colors.primary}
            />
          )
        })}
      </Svg>
      {bars.length === 0 ? <Text variant="bodySmall">{t("beacon.cost.noData")}</Text> : null}
    </View>
  )
}
