import { canComplete } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { job, localCompletion, LocalChangeError } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { JobForms } from '~/components/job-forms';
import { JobSyncCard } from '~/components/job-sync';
import { JobPhotos, SignoffSummary } from '~/components/job-work';
import { LocalGate } from '~/components/local-gate';
import {
  Body,
  Button,
  Field,
  Heading,
  NotReadyScreen,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { SignaturePad } from '~/forms/widgets/signature';
import { missingLines } from '~/lib/describe-change';
import { moveJob, recordNobodyToSign, signOffJob } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';

/**
 * Completing a job (P14).
 *
 * Everything the job type asks for is listed with the way to do it right there:
 * the forms still to submit, the photos still to take, the customer's
 * signature. Completing stays unavailable until nothing is missing, and says
 * exactly what is — the same rules the server applies, from `@integr8/core`, so
 * a job completed here is never refused later for want of something.
 */
export default function CompleteScreen() {
  return (
    <LocalGate>
      <Complete />
    </LocalGate>
  );
}

function Complete() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(
    `complete:${id}`,
    ['work_orders', 'submissions', 'forms', 'outbox'],
    async (sql) => {
      const found = await job(sql, id);
      return found === undefined
        ? undefined
        : { detail: found.detail, completion: await localCompletion(sql, id) };
    },
  );
  const [completing, setCompleting] = useState(false);

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  if (state.data?.completion === undefined) {
    return (
      <ScrollScreen>
        <View style={styles.back}>
          <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        </View>
        <Body>{t('mobile.job.notOnPhone')}</Body>
      </ScrollScreen>
    );
  }

  const { detail, completion } = state.data;
  const { workOrder } = detail;
  const lines = missingLines(t, completion.missing);
  const ready = canComplete(completion.missing);

  const complete = async () => {
    setCompleting(true);
    try {
      await moveJob(workOrder.id, 'complete');
      router.back();
    } catch (error) {
      Alert.alert(
        t('mobile.work.failedTitle'),
        error instanceof LocalChangeError ? error.message : t('mobile.work.failed'),
      );
    } finally {
      setCompleting(false);
    }
  };

  return (
    <ScrollScreen>
      <View style={styles.back}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>
      <Body muted>{workOrder.referenceLabel}</Body>
      <Heading>{t('mobile.complete.title', { title: workOrder.title })}</Heading>

      {workOrder.state !== 'in_progress' ? (
        <Body>
          {t('mobile.complete.notStarted', { state: t(`operations.state.${workOrder.state}`) })}
        </Body>
      ) : (
        <View
          accessibilityRole={ready ? 'summary' : 'alert'}
          style={[
            styles.card,
            ready
              ? { backgroundColor: theme.successSubtle, borderColor: theme.success }
              : { backgroundColor: theme.warningSubtle, borderColor: theme.warning },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            {ready ? t('mobile.complete.ready') : t('mobile.complete.missingTitle')}
          </Text>
          {lines.map((line) => (
            <Text key={line} style={[styles.line, { color: theme.text }]}>
              {`• ${line}`}
            </Text>
          ))}
        </View>
      )}

      <JobForms workOrderId={workOrder.id} siteId={detail.site.id} onlyMissing />

      <JobPhotos detail={detail} closed={false} />

      <Signoff
        workOrderId={workOrder.id}
        required={detail.execution.signatureRequired}
        signed={detail.execution.signoff !== null}
      >
        <SignoffSummary detail={detail} />
      </Signoff>

      <Button
        label={t('mobile.complete.complete')}
        busy={completing}
        disabled={!ready || workOrder.state !== 'in_progress'}
        onPress={() => void complete()}
      />

      <JobSyncCard workOrderId={workOrder.id} />
    </ScrollScreen>
  );
}

function Signoff({
  workOrderId,
  required,
  signed,
  children,
}: {
  workOrderId: string;
  required: boolean;
  signed: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(!signed);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [nobody, setNobody] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (signed && !editing) {
    return (
      <Section title={t('mobile.signoff.title')}>
        {children}
        <Button
          label={t('mobile.signoff.again')}
          variant="secondary"
          onPress={() => setEditing(true)}
        />
      </Section>
    );
  }

  const done = () => {
    setEditing(false);
    setName('');
    setRole('');
    setReason('');
    setNobody(false);
  };

  return (
    <Section
      title={
        required
          ? t('mobile.signoff.title')
          : `${t('mobile.signoff.title')} · ${t('mobile.signoff.optional')}`
      }
    >
      {nobody ? (
        <>
          <Field
            label={t('mobile.signoff.reason')}
            placeholder={t('mobile.signoff.reasonPlaceholder')}
            value={reason}
            onChangeText={setReason}
            multiline
          />
          <Button
            label={t('mobile.signoff.saveNobody')}
            busy={saving}
            disabled={reason.trim() === ''}
            onPress={() => {
              setSaving(true);
              void recordNobodyToSign(workOrderId, reason)
                .then(done)
                .finally(() => setSaving(false));
            }}
          />
          <Button
            label={t('mobile.signoff.canSign')}
            variant="secondary"
            onPress={() => setNobody(false)}
          />
        </>
      ) : (
        <>
          <Body muted>{t('mobile.signoff.hint')}</Body>
          <Field
            label={t('mobile.signoff.name')}
            value={name}
            onChangeText={(value) => {
              setName(value);
              setNameError(undefined);
            }}
            autoComplete="name"
            error={nameError}
          />
          <Field
            label={t('mobile.signoff.role')}
            placeholder={t('mobile.signoff.rolePlaceholder')}
            value={role}
            onChangeText={setRole}
          />
          <SignaturePad
            label={t('mobile.signoff.title')}
            disabled={false}
            onSaved={async (uri) => {
              if (name.trim() === '') {
                setNameError(t('mobile.signoff.nameNeeded'));
                return;
              }
              await signOffJob(workOrderId, { snapshotUri: uri, name, role });
              done();
            }}
          />
          <Button
            label={t('mobile.signoff.nobody')}
            variant="secondary"
            onPress={() => setNobody(true)}
          />
        </>
      )}
      {signed ? (
        <Button label={t('common.cancel')} variant="secondary" onPress={() => setEditing(false)} />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  back: { alignItems: 'flex-start' },
  card: {
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  cardTitle: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  line: { fontSize: 15, textAlign: 'auto' },
});
