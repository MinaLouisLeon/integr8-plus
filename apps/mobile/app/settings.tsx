import { checkConformance, type ConformanceCheck } from '@integr8/form-engine/conformance';
import { useTranslation } from '@integr8/i18n';
import { identity, RETENTION, storageSummary, unsentWorkCount } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import { SyncBanner } from '~/components/sync-banner';
import { Body, Button, Detail, Heading, ScrollScreen, Section } from '~/components/ui';
import { formatBytes, formatWhen } from '~/lib/format';
import { session } from '~/lib/session';
import { localData } from '~/local/local-data';
import { useLocalQuery, useLocalStatus } from '~/local/react';

/** Who is signed in, what the phone holds, and signing out — which empties it. */
export default function SettingsScreen() {
  return (
    <LocalGate>
      <Settings />
    </LocalGate>
  );
}

function Settings() {
  const { t, i18n } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);
  const status = useLocalStatus();
  const cipherVersion = status.phase === 'open' ? status.cipherVersion : '';
  const me = useLocalQuery('identity', ['meta'], identity);
  const storage = useLocalQuery(
    'storage',
    ['work_orders', 'customers', 'forms', 'submissions', 'outbox', 'uploads', 'files'],
    storageSummary,
  );

  const signOut = async () => {
    setSigningOut(true);
    try {
      // Sign out on the server while the session still exists; the handler in
      // the root layout wipes the phone and returns to the sign-in screen.
      await session().signOut();
      await localData.wipe();
    } finally {
      setSigningOut(false);
    }
  };

  const confirmSignOut = async () => {
    const db = localData.status();
    const unsent = db.phase === 'open' ? await db.db.read(unsentWorkCount) : 0;
    if (unsent === 0) {
      await signOut();
      return;
    }
    Alert.alert(
      t('mobile.settings.unsentTitle'),
      t('mobile.settings.unsentBody', { count: unsent }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('mobile.settings.signOutAnyway'),
          style: 'destructive',
          onPress: () => void signOut(),
        },
      ],
    );
  };

  const person = me.status === 'ready' ? me.data : undefined;

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>
      <Heading>{t('mobile.settings.title')}</Heading>

      {person === undefined ? null : (
        <Section title={t('mobile.settings.account')}>
          <Body>{person.displayName}</Body>
          <Body muted>{person.email}</Body>
          <Detail label={t('mobile.settings.role')}>
            {t(`workspace.role.${person.role as 'engineer'}`, { defaultValue: person.role })}
          </Detail>
        </Section>
      )}

      <SyncBanner />

      {storage.status !== 'ready' ? null : (
        <Section title={t('mobile.settings.onThisPhone')}>
          <Detail label={t('mobile.settings.openJobs')}>{String(storage.data.openJobs)}</Detail>
          <Detail label={t('mobile.settings.closedJobs')}>{String(storage.data.closedJobs)}</Detail>
          <Detail label={t('mobile.settings.customers')}>{String(storage.data.customers)}</Detail>
          <Detail label={t('mobile.settings.forms')}>{String(storage.data.forms)}</Detail>
          <Detail label={t('mobile.settings.unsent')}>{String(storage.data.unsentWork)}</Detail>
          <Detail label={t('mobile.settings.files')}>
            {t('mobile.settings.filesUsage', {
              used: formatBytes(storage.data.downloadedFileBytes, i18n.language),
              budget: formatBytes(RETENTION.downloadedFileBytes, i18n.language),
            })}
          </Detail>
          <Detail label={t('mobile.settings.lastUpdated')}>
            {person?.lastDownloadAt == null
              ? t('mobile.settings.never')
              : formatWhen(person.lastDownloadAt, i18n.language)}
          </Detail>
          <Detail label={t('mobile.settings.encryption')}>
            {cipherVersion === ''
              ? t('mobile.settings.notEncrypted')
              : t('mobile.settings.encrypted', { version: cipherVersion })}
          </Detail>
          <Body muted>{t('mobile.settings.retention')}</Body>
        </Section>
      )}

      <EngineCheck />

      <View style={{ gap: spacing[2] }}>
        <Body muted>{t('mobile.settings.signOutExplained')}</Body>
        <Button
          label={t('mobile.settings.signOut')}
          variant="secondary"
          busy={signingOut}
          onPress={() => void confirmSignOut()}
        />
      </View>
    </ScrollScreen>
  );
}

/**
 * Runs the form engine's conformance corpus on this phone and compares every
 * decision with the server's golden file (P13). CI runs the same corpus in a
 * Hermes that is not quite the one in the app; this is the app's own engine and
 * bytecode, release builds included, so support can ask for it on any phone.
 */
function EngineCheck() {
  const { t } = useTranslation();
  const [result, setResult] = useState<ConformanceCheck | 'running' | undefined>(undefined);
  return (
    <Section title={t('mobile.engineCheck.title')}>
      {result === undefined || result === 'running' ? null : (
        <Body>
          {result.ok
            ? t('mobile.engineCheck.passed', { count: result.cases })
            : t('mobile.engineCheck.failed', {
                count: result.mismatches.length,
                cases: result.mismatches.join(', '),
              })}
        </Body>
      )}
      <Button
        label={result === 'running' ? t('mobile.engineCheck.running') : t('mobile.engineCheck.run')}
        variant="secondary"
        busy={result === 'running'}
        onPress={() => {
          setResult('running');
          // Let the button show that it is working before the corpus holds the thread.
          setTimeout(() => setResult(checkConformance()), 50);
        }}
      />
    </Section>
  );
}
