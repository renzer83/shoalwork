import { View } from "react-native"
import { Button, Card, Text } from "react-native-paper"
import type { ExecutorView } from "../../hooks/useExecutors.js"
import { DOCTOR_LABEL, versionText } from "./executor-model.js"
import { LoginStatus } from "./LoginStatus.js"
import { QualityTable } from "./QualityTable.js"
import { QuotaGauge } from "./QuotaGauge.js"

export interface ExecutorCardProps {
  readonly executor: ExecutorView
  readonly probing: boolean
  readonly onReprobe: (id: string) => void
}

// One executor: its CLI and version against the pin, the doctor's verdict, the quota, the quality and the logins.
export function ExecutorCard({ executor, probing, onReprobe }: ExecutorCardProps) {
  const checked = executor.cli !== null
  return (
    <Card>
      <Card.Content style={{ gap: 12 }}>
        <Text variant="titleMedium">{executor.id}</Text>
        {checked ? (
          <View style={{ gap: 2 }}>
            <Text variant="bodySmall">{`CLI ${executor.cli ?? ""} · ${versionText(executor.installedVersion, executor.pinnedVersion)}`}</Text>
            <Text variant="bodySmall">
              {executor.status === null
                ? "Doctor: ainda não verificado"
                : `Doctor: ${DOCTOR_LABEL[executor.status]}`}
            </Text>
            <Button
              mode="outlined"
              disabled={probing}
              loading={probing}
              onPress={() => onReprobe(executor.id)}
            >
              Rodar doctor
            </Button>
          </View>
        ) : (
          <Text variant="bodySmall">Sem CLI verificado pelo doctor</Text>
        )}
        <QuotaGauge
          usedRatio={executor.quota.usedRatio}
          available={executor.quota.available}
          windowEndsAt={executor.quota.windowEndsAt}
        />
        <QualityTable rows={executor.quality} />
        <LoginStatus logins={executor.logins} />
      </Card.Content>
    </Card>
  )
}
