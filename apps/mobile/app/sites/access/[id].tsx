import { useTranslation } from '@integr8/i18n';
import { site } from '@integr8/offline';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  NotReadyScreen,
  ScrollScreen,
} from '~/components/ui';
import {
  ACCESS_FIELDS,
  ACCESS_MAX_LENGTH,
  accessChanges,
  accessDraft,
  type AccessValuesNow,
} from '~/lib/access-edit';
import { refusalMessage } from '~/lib/refusals';
import { correctAccess } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';

/**
 * Correcting a site's access notes from the phone (P12): the gate code that
 * changed, the parking that moved, a hazard found on arrival.
 *
 * Saved on the phone at once — the site and every job there show it — and sent
 * when there is signal. The server takes it from the office or from someone on
 * the crew of an open job at the site; if a colleague changed the same field
 * meanwhile, the Sync screen asks whose to keep.
 */
export default function CorrectAccessScreen() {
  return (
    <LocalGate>
      <CorrectAccess />
    </LocalGate>
  );
}

function CorrectAccess() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(`site-access:${id}`, ['sites'], (sql) => site(sql, id));

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  if (state.data === undefined) {
    return (
      <ScrollScreen>
        <BackButton />
        <EmptyState title={t('mobile.site.notOnPhone')} body="" />
      </ScrollScreen>
    );
  }
  return (
    <AccessForm siteId={id} siteName={state.data.site.name} current={state.data.site.access} />
  );
}

function AccessForm({
  siteId,
  siteName,
  current,
}: {
  siteId: string;
  siteName: string;
  current: AccessValuesNow;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => accessDraft(current));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await correctAccess(siteId, accessChanges(current, draft));
      router.back();
    } catch (error) {
      Alert.alert(t('mobile.access.failed'), refusalMessage(t, error, t('mobile.work.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('operations.access.edit')}</Heading>
      <Body muted>{siteName}</Body>
      {ACCESS_FIELDS.map((field) => (
        <Field
          key={field}
          label={t(`operations.access.${field}`)}
          value={draft[field]}
          onChangeText={(text) => setDraft((previous) => ({ ...previous, [field]: text }))}
          multiline={field !== 'gateCode'}
          autoCapitalize={field === 'gateCode' ? 'none' : 'sentences'}
          autoCorrect={field !== 'gateCode'}
          maxLength={ACCESS_MAX_LENGTH[field]}
        />
      ))}
      <Body muted>{t('mobile.access.hint')}</Body>
      <Button label={t('operations.access.save')} busy={busy} onPress={() => void save()} />
    </ScrollScreen>
  );
}
