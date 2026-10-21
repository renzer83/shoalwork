import { View } from "react-native"
import { Text } from "react-native-paper"
import { LOGIN_LABEL, type LoginState } from "./executor-model.js"

export interface LoginEntry {
  readonly botId: string
  // The CLI's own auth method name only (e.g. claude.ai); never a credential.
  readonly authMethod: string | null
  readonly state: LoginState
}

// The login of each Bot that runs this executor: state and method, nothing that could be a secret.
export function LoginStatus({ logins }: { readonly logins: ReadonlyArray<LoginEntry> }) {
  if (logins.length === 0) {
    return <Text variant="bodySmall">Sem login a verificar para este executor</Text>
  }
  return (
    <View style={{ gap: 4 }}>
      {logins.map((login) => (
        <Text key={login.botId} variant="bodySmall">
          {`${login.botId} · ${LOGIN_LABEL[login.state]}${login.authMethod === null ? "" : ` · método ${login.authMethod}`}`}
        </Text>
      ))}
    </View>
  )
}
