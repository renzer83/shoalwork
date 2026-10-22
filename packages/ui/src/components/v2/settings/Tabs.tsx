import { Pressable, Text, View } from "react-native"
import { tokens } from "../../../theme.js"
import { Icon, type IconName } from "../Icon.js"

export interface TabItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly icon?: IconName
}

export interface TabsProps<T extends string> {
  readonly tabs: ReadonlyArray<TabItem<T>>
  readonly active: T
  readonly onChange: (id: T) => void
  readonly label: string
  // `pill` is the dark button row of the screen; `text` the plain row of the executor panel.
  readonly variant?: "pill" | "text"
}

// The row of tabs: the active one is the blue pill (or the blue-filled cell in the panel), the others are dark.
export function Tabs<T extends string>({ tabs, active, onChange, label, variant = "pill" }: TabsProps<T>) {
  const pill = variant === "pill"
  return (
    <View
      role="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        gap: pill ? 10 : 0,
        flexWrap: "wrap",
        ...(pill
          ? {}
          : {
              borderRadius: tokens.radius.button,
              backgroundColor: tokens.color.surface,
              borderWidth: 1,
              borderColor: tokens.color.border,
              overflow: "hidden",
            }),
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <Pressable
            key={tab.id}
            role="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              minHeight: pill ? 44 : 40,
              paddingHorizontal: pill ? 16 : 14,
              borderRadius: pill ? tokens.radius.button : 0,
              borderWidth: pill ? 1 : 0,
              borderColor: selected ? tokens.color.accent : tokens.color.border,
              backgroundColor: selected
                ? tokens.color.accent
                : pressed
                  ? tokens.color.elevated
                  : pill
                    ? tokens.color.surface
                    : "transparent",
              ...(pill ? {} : { flex: 1 }),
            })}
          >
            {tab.icon === undefined ? null : (
              <Icon
                name={tab.icon}
                size={16}
                color={selected ? tokens.color.text : tokens.color.textSecondary}
              />
            )}
            <Text
              numberOfLines={1}
              style={{
                color: selected ? tokens.color.text : tokens.color.textSecondary,
                fontSize: 14,
                fontWeight: selected ? "700" : "400",
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
