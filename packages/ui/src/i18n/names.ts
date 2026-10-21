// Display names of the system's components. The code keeps the technical names (Lead, Bot, Pod, Reflex, Reef, Tank,
// Beacon, Current, Tide); what a person reads is looked up here by key. The "pt" set is opt-in: the default is "en".
export const CODENAME_KEYS = [
  "lead",
  "bot",
  "pod",
  "reflex",
  "reef",
  "tank",
  "beacon",
  "current",
  "tide",
] as const
export type CodenameKey = (typeof CODENAME_KEYS)[number]

export type Codenames = "pt" | "en"

export const CODENAMES: Readonly<Record<Codenames, Readonly<Record<CodenameKey, string>>>> = {
  en: {
    lead: "Lead",
    bot: "Bot",
    pod: "Pod",
    reflex: "Reflex",
    reef: "Reef",
    tank: "Tank",
    beacon: "Beacon",
    current: "Current",
    tide: "Tide",
  },
  pt: {
    lead: "Guia",
    bot: "Peixe",
    pod: "Time",
    reflex: "Reflexo",
    reef: "Recife",
    tank: "Tanque",
    beacon: "Farol",
    current: "Corrente",
    tide: "Maré",
  },
}

export const DEFAULT_CODENAMES: Codenames = "en"

export const codenameOf = (key: CodenameKey, codenames: Codenames = DEFAULT_CODENAMES): string =>
  CODENAMES[codenames][key]
