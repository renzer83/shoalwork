import type { NewBot } from "@shoalwork/contracts"
import { useState } from "react"
import { View } from "react-native"
import { Button, HelperText, Text, TextInput } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import { type BotDraft, FIELDS, type FieldErrors, validateDraft } from "./bot-form-model.js"

export interface BotFormProps {
  readonly initial: BotDraft
  // Gets only a bot that passed the NewBot schema, so nothing invalid is sent.
  readonly onSubmit: (bot: NewBot) => void
}

// The Bot's ficha. Validation runs on submit with the NewBot schema; each error shows under its field.
export function BotForm({ initial, onSubmit }: BotFormProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<BotDraft>(initial)
  const [errors, setErrors] = useState<FieldErrors>({})

  const change = (key: keyof BotDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const submit = () => {
    const result = validateDraft(draft)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onSubmit(result.bot)
  }

  return (
    <View style={{ gap: 8 }}>
      {FIELDS.map((field) => (
        <View key={field.key}>
          <TextInput
            label={t(field.labelKey)}
            value={draft[field.key]}
            onChangeText={(value) => change(field.key, value)}
            multiline={"multiline" in field && field.multiline === true}
            autoCapitalize="none"
            autoCorrect={false}
            error={errors[field.key] !== undefined}
          />
          {errors[field.key] === undefined ? null : <HelperText type="error">{errors[field.key]}</HelperText>}
        </View>
      ))}
      {errors.form === undefined ? null : <HelperText type="error">{errors.form}</HelperText>}
      <Text variant="bodySmall">{t("botForm.freeText")}</Text>
      <Button mode="contained" onPress={submit}>
        {t("common.save")}
      </Button>
    </View>
  )
}
