import { View } from "react-native"
import { Text } from "react-native-paper"
import { useLocale } from "../../i18n/index.js"
import { LOGIN_LABEL, type LoginState } from "./executor-model.js"

export interface LoginEntry {
  readonly botId: string
  // The CLI's own auth method name only (e.g. claude.ai); never a credential.
  readonly authMethod: string | null
  readonly state: LoginState
}

// The login of each Bot that runs this executor: state and method, nothing that could be a secret.
export function LoginStatus({ logins }: { readonly logins: ReadonlyArray<LoginEntry> }) {
  const { t } = useLocale()
  if (logins.length === 0) {
    return <Text variant="bodySmall">{t("executors.login.none")}</Text>
  }
  return (
    <View style={{ gap: 4 }}>
      {logins.map((login) => (
        <Text key={login.botId} variant="bodySmall">
          {t("executors.login.line", {
            bot: login.botId,
            state: t(LOGIN_LABEL[login.state]),
            method:
              login.authMethod === null ? "" : t("executors.login.method", { method: login.authMethod }),
          })}
        </Text>
      ))}
    </View>
  )
}
