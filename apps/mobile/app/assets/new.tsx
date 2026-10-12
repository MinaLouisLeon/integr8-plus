import { ASSET_CONDITIONS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import type { ConditionValue } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import { Body, Button, Field, Heading, ScrollScreen, Section, useTheme } from '~/components/ui';
import { BarcodeScanner } from '~/forms/widgets/barcode';
import { registerAsset } from '~/local/job-actions';
import { refusalMessage } from '~/lib/refusals';

/**
 * Registering an asset found on site (CRM/ERP plan, phase E3; ADR-0008): at
 * the job's site, linked to the job, recorded on the phone at once and sent
 * with the job. The office prints its tag; the serial can be scanned from
 * the manufacturer's plate.
 */
export default function NewAssetScreen() {
  return (
    <LocalGate>
      <NewAsset />
    </LocalGate>
  );
}

function NewAsset() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { workOrderId } = useLocalSearchParams<{ workOrderId: string }>();
  const [name, setName] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [where, setWhere] = useState('');
  const [condition, setCondition] = useState<ConditionValue | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = () => {
    setBusy(true);
    registerAsset({
      workOrderId,
      name,
      ...(make.trim() === '' ? {} : { make }),
      ...(model.trim() === '' ? {} : { model }),
      ...(serial.trim() === '' ? {} : { serialNumber: serial }),
      ...(where.trim() === '' ? {} : { locationNote: where }),
      ...(condition === null ? {} : { condition }),
    })
      .then((id) => router.replace({ pathname: '/assets/[id]', params: { id, workOrderId } }))
      .catch((error: unknown) =>
        Alert.alert(t('mobile.assets.failed'), refusalMessage(t, error, '')),
      )
      .finally(() => setBusy(false));
  };

  return (
    <ScrollScreen>
      <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      <Heading>{t('mobile.assets.register')}</Heading>
      <Body muted>{t('mobile.assets.registerHint')}</Body>
      <Field label={t('assets.fields.name')} value={name} onChangeText={setName} />
      <Field label={t('assets.fields.make')} value={make} onChangeText={setMake} />
      <Field label={t('assets.fields.model')} value={model} onChangeText={setModel} />
      <Field
        label={t('assets.fields.serialNumber')}
        value={serial}
        onChangeText={setSerial}
        autoCapitalize="characters"
      />
      <Button
        label={t('mobile.assets.scanSerial')}
        variant="secondary"
        onPress={() => setScanning(true)}
      />
      <Field label={t('assets.fields.locationNote')} value={where} onChangeText={setWhere} />
      <Section title={t('assets.conditionNow')}>
        <View style={styles.choices}>
          {ASSET_CONDITIONS.map((candidate) => {
            const chosen = condition === candidate;
            return (
              <Pressable
                key={candidate}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen }}
                onPress={() => setCondition(chosen ? null : candidate)}
                style={[
                  styles.choice,
                  {
                    borderColor: chosen ? theme.accent : theme.border,
                    backgroundColor: chosen ? theme.accent : theme.surface,
                  },
                ]}
              >
                <Text style={{ color: chosen ? theme.onAccent : theme.text, fontWeight: '600' }}>
                  {t(`assets.condition.${candidate}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>
      <Button
        label={busy ? t('assets.saving') : t('assets.register')}
        disabled={name.trim() === '' || busy}
        onPress={save}
      />
      {scanning ? (
        <BarcodeScanner
          onScanned={(value) => {
            setSerial(value);
            setScanning(false);
          }}
          onCancel={() => setScanning(false)}
        />
      ) : null}
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  choice: {
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
