import { useMemo, useRef } from "react"
import { PanResponder, Text, View } from "react-native"
import { type MessageKey, useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { Icon } from "../Icon.js"
import { Dropdown } from "./Dropdown.js"
import { ExecutorIcon } from "./ExecutorIcon.js"
import { executorName, familyOf, modelLabel } from "./executor-catalog.js"
import {
  moveEntry,
  patchEntry,
  ROUTE_PROFILES,
  ROUTE_RULES,
  type RouteEntry,
  type RouteProfile,
  type RouteRule,
} from "./settings-model.js"

export interface RoutingListProps {
  readonly entries: ReadonlyArray<RouteEntry>
  readonly onChange: (entries: ReadonlyArray<RouteEntry>) => void
}

const ROW_HEIGHT = 52

const RULE_LABEL: Readonly<Record<RouteRule, MessageKey>> = {
  always: "settings.routing.rule.always",
  fallback: "settings.routing.rule.fallback",
  last: "settings.routing.rule.last",
}

const PROFILE_LABEL: Readonly<Record<RouteProfile, MessageKey>> = {
  quality: "settings.routing.profile.quality",
  balanced: "settings.routing.profile.balanced",
  speed: "settings.routing.profile.speed",
}

// The `⋮⋮` handle. Dragging it moves the row by whole row heights; with the focus on it, the up and down arrows move
// the row one place (the way a keyboard or a screen reader reorders).
function Handle({ label, onMove }: { readonly label: string; readonly onMove: (delta: number) => void }) {
  const move = useRef(onMove)
  move.current = onMove
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderRelease: (_event, gesture) => {
          const delta = Math.round(gesture.dy / ROW_HEIGHT)
          if (delta !== 0) move.current(delta)
        },
      }),
    [],
  )
  return (
    <View
      {...responder.panHandlers}
      role="button"
      tabIndex={0}
      accessibilityLabel={label}
      onKeyDown={(event) => {
        const key = event.nativeEvent.key
        if (key === "ArrowUp") move.current(-1)
        else if (key === "ArrowDown") move.current(1)
      }}
      style={{ width: 32, height: 40, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="grip" size={22} color={tokens.color.textSecondary} strokeWidth={3} />
    </View>
  )
}

// `Ordem de resposta do Guia`: numbered rows of model, rule and profile, reorderable.
export function RoutingList({ entries, onChange }: RoutingListProps) {
  const { t } = useLocale()
  const rules = ROUTE_RULES.map((value) => ({ value, label: t(RULE_LABEL[value]) }))
  const profiles = ROUTE_PROFILES.map((value) => ({ value, label: t(PROFILE_LABEL[value]) }))
  if (entries.length === 0) {
    return (
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{t("settings.routing.empty")}</Text>
    )
  }
  return (
    <View accessibilityLabel={t("settings.routing.title")} style={{ gap: 8 }}>
      {entries.map((entry, index) => {
        const name =
          entry.model === "" ? executorName(entry.executor) : modelLabel(entry.executor, entry.model)
        return (
          <View
            key={`${entry.executor}:${entry.model}`}
            accessibilityLabel={t("settings.routing.row", { n: index + 1, name })}
            style={{
              height: ROW_HEIGHT - 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              zIndex: entries.length - index,
            }}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: tokens.radius.chip,
                borderWidth: 1,
                borderColor: tokens.color.border,
                backgroundColor: tokens.color.surface,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: tokens.color.text, fontSize: 14 }}>{index + 1}</Text>
            </View>
            <ExecutorIcon family={familyOf(entry.executor)} size={30} />
            <Text numberOfLines={1} style={{ flex: 1, color: tokens.color.text, fontSize: 14 }}>
              {name}
            </Text>
            <Dropdown
              value={entry.rule}
              options={rules}
              onChange={(rule) => onChange(patchEntry(entries, index, { rule }))}
              label={t("settings.routing.ruleLabel", { name })}
              width={190}
            />
            <Dropdown
              value={entry.profile}
              options={profiles}
              onChange={(profile) => onChange(patchEntry(entries, index, { profile }))}
              label={t("settings.routing.profileLabel", { name })}
              width={130}
            />
            <Handle
              label={t("settings.routing.move", { name })}
              onMove={(delta) => onChange(moveEntry(entries, index, index + delta))}
            />
          </View>
        )
      })}
    </View>
  )
}
