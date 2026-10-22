import { Text, TextInput, View } from "react-native"
import { LOCALES, type Locale, useLocale } from "../../../../i18n/index.js"
import { tokens } from "../../../../theme.js"
import { Card } from "../../Card.js"
import { Dropdown } from "../Dropdown.js"
import { SectionHeading } from "./ExecutorsTab.js"

// What the General tab edits: the core address, its token (the one secret field of the screen, never shown) and the
// language. Saved with the rest by `Salvar alterações`.
export interface GeneralDraft {
  readonly baseUrl: string
  readonly token: string
  readonly locale: Locale
}

export interface GeneralTabProps {
  readonly draft: GeneralDraft
  readonly onChange: (draft: GeneralDraft) => void
}

const LOCALE_NAME: Readonly<Record<Locale, string>> = { "pt-BR": "Português (Brasil)", en: "English" }

function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly secret?: boolean
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secret}
        placeholderTextColor={tokens.color.textSecondary}
        style={{
          minHeight: 44,
          paddingHorizontal: 12,
          borderRadius: tokens.radius.button,
          borderWidth: 1,
          borderColor: tokens.color.border,
          backgroundColor: tokens.color.background,
          color: tokens.color.text,
          fontSize: 14,
          fontFamily: tokens.font.mono,
        }}
      />
    </View>
  )
}

// `Geral`: where the core is and the language of the app.
export function GeneralTab({ draft, onChange }: GeneralTabProps) {
  const { t } = useLocale()
  return (
    <View style={{ gap: 14 }}>
      <SectionHeading title={t("settings.general.title")} subtitle={t("settings.general.subtitle")} />
      <Card style={{ gap: 14, zIndex: 1 }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.color.text, fontSize: 17, fontWeight: "700" }}
        >
          {t("settings.general.server")}
        </Text>
        <Field
          label={t("setup.coreUrl")}
          value={draft.baseUrl}
          onChange={(baseUrl) => onChange({ ...draft, baseUrl })}
        />
        <Field
          label={t("setup.token")}
          value={draft.token}
          onChange={(token) => onChange({ ...draft, token })}
          secret
        />
      </Card>
      <Card style={{ gap: 14, zIndex: 2 }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.color.text, fontSize: 17, fontWeight: "700" }}
        >
          {t("settings.general.language")}
        </Text>
        <Dropdown
          value={draft.locale}
          options={LOCALES.map((value) => ({ value, label: LOCALE_NAME[value] }))}
          onChange={(locale) => onChange({ ...draft, locale })}
          label={t("settings.general.language")}
          width={260}
        />
      </Card>
    </View>
  )
}
