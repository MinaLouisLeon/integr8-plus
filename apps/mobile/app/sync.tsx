import { useTranslation } from '@integr8/i18n';
import {
  changesNeedingAttention,
  describeChanges,
  retryUpload,
  syncStatus,
  uploadsInProgress,
} from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import { SyncBanner } from '~/components/sync-banner';
import {
  Body,
  Button,
  Detail,
  Heading,
  LocalReadError,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { describeChange, describeRefusal } from '~/lib/describe-change';
import { formatBytes, formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useLocalQuery, useSyncActivity } from '~/local/react';

/**
 * Everything about sync on one screen (P12): what is waiting, what is uploading,
 * when the phone last agreed with the office, and every change that needs the
 * engineer — each described as they made it, with what to do about it.
 */
export default function SyncScreen() {
  return (
    <LocalGate>
      <Sync />
    </LocalGate>
  );
}

function Sync() {
  const { t, i18n } = useTranslation();
  const activity = useSyncActivity();
  const status = useLocalQuery('sync-status', ['outbox', 'uploads', 'meta'], syncStatus);
  const attention = useLocalQuery(
    'sync-attention',
    ['outbox', 'work_orders', 'submissions', 'sites'],
    async (sql) => describeChanges(sql, await changesNeedingAttention(sql)),
  );
  const uploads = useLocalQuery('sync-uploads', ['uploads'], uploadsInProgress);

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>
      <Heading>{t('mobile.syncScreen.title')}</Heading>
      <SyncBanner />

      {[status, attention, uploads].some((query) => query.status === 'error') ? (
        <LocalReadError />
      ) : null}

      {status.status !== 'ready' ? null : (
        <Section title={t('mobile.syncScreen.title')}>
          <Detail label={t('mobile.syncScreen.lastSynced')}>
            {status.data.lastSuccessfulSyncAt === null
              ? t('mobile.syncScreen.never')
              : formatWhen(status.data.lastSuccessfulSyncAt, i18n.language)}
          </Detail>
          <Detail label={t('mobile.syncScreen.waitingChanges')}>
            {String(status.data.pendingChanges)}
          </Detail>
          <Detail label={t('mobile.syncScreen.waitingFiles')}>
            {`${String(status.data.pendingUploads)} · ${formatBytes(status.data.pendingUploadBytes, i18n.language)}`}
          </Detail>
          <Button
            label={t('mobile.syncState.syncNow')}
            busy={activity.phase !== 'idle'}
            onPress={() => void localData.sync('manual', true)}
          />
        </Section>
      )}

      <Section title={t('mobile.syncScreen.needsAttention')}>
        {attention.status !== 'ready' ? null : attention.data.length === 0 ? (
          <Body muted>{t('mobile.syncScreen.nothing')}</Body>
        ) : (
          attention.data.map((change) => (
            <Row
              key={change.id}
              title={describeChange(t, change)}
              lines={[describeRefusal(t, change), change.job?.title ?? '']}
              tag={{
                label:
                  change.state === 'conflict'
                    ? t('mobile.syncScreen.resolve')
                    : t('mobile.syncScreen.retry'),
                tone: 'danger',
              }}
              onPress={() =>
                router.push({ pathname: '/conflicts/[id]', params: { id: change.id } })
              }
            />
          ))
        )}
      </Section>

      {uploads.status !== 'ready' || uploads.data.length === 0 ? null : (
        <Section title={t('mobile.syncScreen.uploads')}>
          {uploads.data.map((upload) => (
            <View key={upload.mediaId} style={{ gap: spacing[1] }}>
              <Row
                title={upload.contentType}
                lines={[
                  upload.state === 'failed'
                    ? t('mobile.syncScreen.uploadFailed', { code: upload.error ?? '' })
                    : t('mobile.syncScreen.uploadProgress', {
                        sent: formatBytes(upload.bytesSent, i18n.language),
                        size: formatBytes(upload.byteSize, i18n.language),
                      }),
                ]}
                tag={
                  upload.state === 'failed'
                    ? { label: t('mobile.syncScreen.retry'), tone: 'danger' }
                    : undefined
                }
                onPress={
                  upload.state === 'failed'
                    ? () => {
                        const context = localData.changeContext();
                        if (context !== undefined) {
                          void retryUpload(context.db, upload.mediaId).then(() =>
                            localData.sync('manual', true),
                          );
                        }
                      }
                    : undefined
                }
              />
            </View>
          ))}
        </Section>
      )}
    </ScrollScreen>
  );
}
