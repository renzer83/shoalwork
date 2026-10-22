import { useCallback, useEffect, useMemo, useState } from "react"
import {
  EMPTY_PREFERENCES,
  PREFERENCES_KEY,
  type Preferences,
  parsePreferences,
  samePreferences,
  serializePreferences,
} from "../components/v2/settings/settings-model.js"
import { defaultStore, type KeyValueStore } from "../storage.js"

export interface SettingsPreferences {
  // What is on screen, including edits not saved yet.
  readonly draft: Preferences
  readonly edit: (change: (current: Preferences) => Preferences) => void
  // True when the draft differs from what is saved.
  readonly dirty: boolean
  readonly save: () => Promise<void>
}

// The choices of the Configuração screen, kept on this device. Edits live in a draft until `save`.
export function useSettingsPreferences(store?: KeyValueStore): SettingsPreferences {
  const kv = useMemo(() => store ?? defaultStore(), [store])
  const [saved, setSaved] = useState<Preferences>(EMPTY_PREFERENCES)
  const [draft, setDraft] = useState<Preferences>(EMPTY_PREFERENCES)

  useEffect(() => {
    let cancelled = false
    void kv
      .get(PREFERENCES_KEY)
      .then((raw) => {
        if (cancelled) return
        const loaded = parsePreferences(raw)
        setSaved(loaded)
        setDraft(loaded)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [kv])

  const edit = useCallback((change: (current: Preferences) => Preferences) => setDraft(change), [])

  const save = useCallback(async () => {
    await kv.set(PREFERENCES_KEY, serializePreferences(draft))
    setSaved(draft)
  }, [kv, draft])

  return { draft, edit, dirty: !samePreferences(saved, draft), save }
}
