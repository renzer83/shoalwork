import { View } from "react-native"
import { useLocale } from "../../../../i18n/index.js"
import { RoutingList } from "../RoutingList.js"
import type { RouteEntry } from "../settings-model.js"
import { SectionHeading } from "./ExecutorsTab.js"

export interface RoutingTabProps {
  readonly routing: ReadonlyArray<RouteEntry>
  readonly onRouting: (entries: ReadonlyArray<RouteEntry>) => void
}

// `Padrões & Roteamento`: the order in which the Guide tries the models, with the rule and profile of each.
export function RoutingTab({ routing, onRouting }: RoutingTabProps) {
  const { t } = useLocale()
  return (
    <View>
      <SectionHeading title={t("settings.routing.title")} subtitle={t("settings.routing.subtitle")} />
      <RoutingList entries={routing} onChange={onRouting} />
    </View>
  )
}
