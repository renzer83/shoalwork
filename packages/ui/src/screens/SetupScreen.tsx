import { useEffect, useState } from "react"
import { ScrollView, View } from "react-native"
import { Button, TextInput, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { useLocale } from "../i18n/index.js"

export function SetupScreen({ onDone }: { readonly onDone?: () => void }) {
  const { config, ready, save } = useApi()
  const theme = useTheme()
  const { t } = useLocale()
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [token, setToken] = useState(config.token ?? "")

  useEffect(() => {
    if (ready) {
      setBaseUrl(config.baseUrl)
      setToken(config.token ?? "")
    }
  }, [ready, config.baseUrl, config.token])

  const submit = () => {
    void save({ baseUrl: baseUrl.trim(), token: token.trim() === "" ? null : token.trim() }).then(onDone)
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("setup.title")} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <TextInput
          label={t("setup.coreUrl")}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          label={t("setup.token")}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Button mode="contained" onPress={submit}>
          {t("common.save")}
        </Button>
      </ScrollView>
    </View>
  )
}
