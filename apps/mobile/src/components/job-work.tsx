import type { WorkOrderState } from '@integr8/core';
import { type TFunction, useTranslation } from '@integr8/i18n';
import {
  addressText,
  currentShift,
  localCompletion,
  localMedia,
  LocalChangeError,
  recordChecklist,
  timesOnJob,
  type WorkOrderDetail,
} from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { imageUri } from '~/forms/media';
import { formatDuration, formatWhen } from '~/lib/format';
import { navigationLinks } from '~/lib/navigation';
import { jobSteps } from '~/lib/today';
import {
  addJobPhotos,
  clockIn,
  moveJob,
  openAttachment,
  removeJobPhoto,
} from '~/local/job-actions';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';
import { useNow } from '~/lib/use-now';
import { Body, Button, Detail, LocalReadError, Row, Section, useTheme } from './ui';

/**
 * The parts of a job the engineer works through on the phone (P14): the next
 * step, time on the job, photos, the checklist, the files, the sign-off.
 */

type Job = WorkOrderDetail;

/** Opens directions to the job's site in the phone's maps app. */
export async function navigateTo(site: Job['site'], address: string): Promise<void> {
  const links = navigationLinks(Platform.OS === 'ios' ? 'ios' : 'android', {
    label: site.name,
    address,
    location: site.location,
  });
  for (const link of links.slice(0, -1)) {
    if (await Linking.canOpenURL(link).catch(() => false)) {
      await Linking.openURL(link);
      return;
    }
  }
  await Linking.openURL(links[links.length - 1]!);
}

/**
 * Taking a step on a job, with the prompts the job type asks for: clock in
 * before the first job of the day, photograph before starting work, and — for
 * completing — the completion screen, which says what is still needed.
 */
export function useJobStep() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<WorkOrderState | undefined>(undefined);

  const run = async (detail: Job, to: WorkOrderState) => {
    setBusy(to);
    try {
      await moveJob(detail.workOrder.id, to);
    } catch (error) {
      Alert.alert(
        t('mobile.work.failedTitle'),
        error instanceof LocalChangeError ? error.message : t('mobile.work.failed'),
      );
    } finally {
      setBusy(undefined);
    }
  };

  const take = async (detail: Job, to: WorkOrderState) => {
    const jobId = detail.workOrder.id;
    if (to === 'complete') {
      router.push({ pathname: '/jobs/complete/[id]', params: { id: jobId } });
      return;
    }
    const status = localData.status();
    const db = status.phase === 'open' ? status.db : undefined;
    if (db === undefined) {
      return;
    }
    if ((to === 'travelling' || to === 'on_site') && (await db.read(currentShift)) === undefined) {
      Alert.alert(t('mobile.work.clockInTitle'), t('mobile.work.clockInBody'), [
        { text: t('mobile.work.withoutClockIn'), onPress: () => void run(detail, to) },
        {
          text: t('mobile.today.clockIn'),
          style: 'default',
          onPress: () =>
            void clockIn()
              .catch(() => undefined)
              .then(() => run(detail, to)),
        },
      ]);
      return;
    }
    if (to === 'in_progress') {
      const completion = await db.read((sql) => localCompletion(sql, jobId));
      const needed = completion?.missing.beforePhotos ?? 0;
      if (needed > 0) {
        Alert.alert(
          t('mobile.work.beforePhotosTitle'),
          t('mobile.work.beforePhotosBody', { count: needed }),
          [
            { text: t('mobile.work.notNow'), onPress: () => void run(detail, to) },
            {
              text: t('mobile.photos.take'),
              onPress: () =>
                void addJobPhotos(jobId, 'before', 'camera')
                  .catch(() => undefined)
                  .then(() => run(detail, to)),
            },
          ],
        );
        return;
      }
    }
    await run(detail, to);
  };

  return { busy, take };
}

export function JobActions({ detail }: { detail: Job }) {
  const { t } = useTranslation();
  const { busy, take } = useJobStep();
  const steps = jobSteps(detail.workOrder.state);

  return (
    <View style={styles.actions}>
      {steps.primary === undefined ? null : (
        <Button
          label={t(`mobile.work.step.${steps.primary}`)}
          busy={busy === steps.primary}
          disabled={busy !== undefined}
          onPress={() => void take(detail, steps.primary!)}
        />
      )}
      <View style={styles.actionRow}>
        <View style={styles.grow}>
          <Button
            label={t('mobile.work.directions')}
            variant="secondary"
            onPress={() => void navigateTo(detail.site, addressText(detail.site.address))}
          />
        </View>
        {steps.others.map((to) => (
          <View key={to} style={styles.grow}>
            <Button
              label={t(`mobile.work.step.${to}`)}
              variant="secondary"
              busy={busy === to}
              disabled={busy !== undefined}
              onPress={() => void take(detail, to)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Where the engineer is with the job, and for how long: "On site since 09:12 · 25 min". */
export function jobStatusLine(t: TFunction, detail: Job, now: Date, locale: string): string {
  // Since the job last entered its state: a second trip to the merchant counts from leaving again.
  const entered = detail.events
    .filter((event) => event.kind === 'transitioned' && event.toState === detail.workOrder.state)
    .map((event) => event.occurredAt)
    .sort()
    .at(-1);
  const since =
    entered === undefined
      ? ''
      : ` ${t('mobile.work.since', {
          when: formatWhen(entered, locale, now),
          duration: formatDuration(now.getTime() - new Date(entered).getTime(), locale),
        })}`;
  switch (detail.workOrder.state) {
    case 'travelling':
    case 'on_site':
    case 'in_progress':
      return `${t(`mobile.work.status.${detail.workOrder.state}`)}${since}`;
    default:
      return t(`operations.state.${detail.workOrder.state}`);
  }
}

export function JobTimes({ detail }: { detail: Job }) {
  const { t, i18n } = useTranslation();
  const now = useNow(60_000);
  const times = timesOnJob(detail, now);
  if (times.travelMs + times.onSiteMs + times.workMs + times.waitingMs === 0) {
    return null;
  }
  const duration = (ms: number) => formatDuration(ms, i18n.language);
  return (
    <Section title={t('mobile.work.time')}>
      <Body>{jobStatusLine(t, detail, now, i18n.language)}</Body>
      <Body muted>
        {[
          t('mobile.work.travel', { duration: duration(times.travelMs) }),
          t('mobile.work.onSite', { duration: duration(times.onSiteMs) }),
          t('mobile.work.working', { duration: duration(times.workMs) }),
          ...(times.waitingMs > 0
            ? [t('mobile.work.waiting', { duration: duration(times.waitingMs) })]
            : []),
        ].join(' · ')}
      </Body>
    </Section>
  );
}

/** Before and after photos, with how many the job type asks for. */
export function JobPhotos({ detail, closed }: { detail: Job; closed: boolean }) {
  const { t } = useTranslation();
  const { beforePhotos, afterPhotos } = detail.execution;
  const photos = detail.attachments.filter((attachment) => attachment.stage !== null);
  if (beforePhotos === 0 && afterPhotos === 0 && photos.length === 0) {
    return null;
  }
  return (
    <Section title={t('mobile.photos.title')}>
      <PhotoStage detail={detail} stage="before" needed={beforePhotos} closed={closed} />
      <PhotoStage detail={detail} stage="after" needed={afterPhotos} closed={closed} />
    </Section>
  );
}

function PhotoStage({
  detail,
  stage,
  needed,
  closed,
}: {
  detail: Job;
  stage: 'before' | 'after';
  needed: number;
  closed: boolean;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const jobId = detail.workOrder.id;
  const photos = detail.attachments.filter((attachment) => attachment.stage === stage);
  const ids = photos.map((photo) => photo.fileId).sort();
  const local = useLocalQuery(`photos:${ids.join(',')}`, ['uploads'], (sql) =>
    localMedia(sql, ids),
  );

  const add = async (source: 'camera' | 'library') => {
    setBusy(true);
    try {
      const result = await addJobPhotos(jobId, stage, source);
      if (result.outcome === 'denied') {
        Alert.alert(t('mobile.photos.deniedTitle'), t('mobile.photos.denied'));
      }
    } catch {
      Alert.alert(t('mobile.work.failedTitle'), t('mobile.photos.failed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = (attachmentId: string) =>
    Alert.alert(t('mobile.photos.removeTitle'), '', [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('mobile.photos.remove'),
        style: 'destructive',
        onPress: () => void removeJobPhoto(jobId, attachmentId),
      },
    ]);

  if (needed === 0 && photos.length === 0) {
    return null;
  }
  return (
    <View style={styles.stage}>
      <Body>
        {needed > 0
          ? t(`mobile.photos.${stage}Needed`, { taken: photos.length, needed })
          : t(`mobile.photos.${stage}`, { count: photos.length })}
      </Body>
      {local.status === 'error' ? <LocalReadError /> : null}
      <View style={styles.thumbs}>
        {photos.map((photo) => {
          const uri = local.status === 'ready' ? imageUri(local.data.get(photo.fileId)) : undefined;
          return (
            <Pressable
              key={photo.id}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.photos.photoOf', { title: photo.title })}
              disabled={closed}
              onLongPress={() => remove(photo.id)}
              style={[styles.thumb, { borderColor: theme.border, backgroundColor: theme.surface }]}
            >
              {uri === undefined ? (
                <Text style={[styles.thumbText, { color: theme.textMuted }]}>
                  {t('mobile.photos.elsewhere')}
                </Text>
              ) : (
                <Image source={{ uri }} style={styles.thumbImage} resizeMode="cover" />
              )}
            </Pressable>
          );
        })}
      </View>
      {closed ? null : (
        <View style={styles.actionRow}>
          <View style={styles.grow}>
            <Button
              label={t('mobile.photos.take')}
              variant={photos.length < needed ? 'primary' : 'secondary'}
              busy={busy}
              onPress={() => void add('camera')}
            />
          </View>
          <View style={styles.grow}>
            <Button
              label={t('mobile.photos.choose')}
              variant="secondary"
              disabled={busy}
              onPress={() => void add('library')}
            />
          </View>
        </View>
      )}
    </View>
  );
}

/** The checklist, ticked on the phone. */
export function JobChecklist({ detail, closed }: { detail: Job; closed: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  if (detail.checklist.length === 0) {
    return null;
  }
  const toggle = async (itemId: string, done: boolean) => {
    const context = localData.changeContext();
    if (context === undefined) {
      return;
    }
    await recordChecklist(context, { workOrderId: detail.workOrder.id, itemId, done });
    void localData.sync('change');
  };
  return (
    <Section title={t('mobile.job.checklist')}>
      {detail.checklist.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.done, disabled: closed }}
          disabled={closed}
          onPress={() => void toggle(item.id, !item.done)}
          style={[styles.check, { borderColor: theme.border, backgroundColor: theme.surface }]}
        >
          <Text style={[styles.checkMark, { color: item.done ? theme.accent : theme.textMuted }]}>
            {item.done ? '☑' : '☐'}
          </Text>
          <Text style={[styles.checkLabel, { color: theme.text }]}>{item.label}</Text>
        </Pressable>
      ))}
    </Section>
  );
}

/** Files that came with the job, opened from the phone's copy. */
export function JobAttachments({ detail }: { detail: Job }) {
  const { t, i18n } = useTranslation();
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const files = detail.attachments.filter((attachment) => attachment.stage === null);
  if (files.length === 0) {
    return null;
  }
  const open = async (attachment: Job['attachments'][number]) => {
    setOpening(attachment.id);
    try {
      if (!(await openAttachment(detail.workOrder.id, attachment))) {
        Alert.alert(attachment.title, t('mobile.files.unavailable'));
      }
    } finally {
      setOpening(undefined);
    }
  };
  return (
    <Section title={t('mobile.files.title')}>
      {files.map((attachment) => (
        <Row
          key={attachment.id}
          title={attachment.title}
          lines={[
            opening === attachment.id
              ? t('common.loading')
              : `${t(`operations.workOrder.kind.${attachment.kind}`)} · ${formatWhen(attachment.createdAt, i18n.language)}`,
          ]}
          onPress={() => void open(attachment)}
        />
      ))}
    </Section>
  );
}

/** Who signed the job off, or why nobody could. */
export function SignoffSummary({ detail }: { detail: Job }) {
  const { t, i18n } = useTranslation();
  const { signoff, signatureRequired } = detail.execution;
  if (signoff === null) {
    return signatureRequired ? (
      <Detail label={t('mobile.signoff.title')}>{t('mobile.signoff.notYet')}</Detail>
    ) : null;
  }
  const when = formatWhen(signoff.signedAt, i18n.language);
  return (
    <Detail label={t('mobile.signoff.title')}>
      {signoff.unavailableReason === null
        ? t('mobile.signoff.signedBy', {
            name:
              signoff.role === null
                ? (signoff.name ?? '')
                : `${signoff.name ?? ''} (${signoff.role})`,
            when,
          })
        : t('mobile.signoff.nobodySigned', { reason: signoff.unavailableReason, when })}
    </Detail>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing[2] },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  grow: { flexGrow: 1, flexBasis: '45%' },
  stage: { gap: spacing[2] },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  thumb: {
    width: 88,
    height: 88,
    borderWidth: 1,
    borderRadius: radii.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbText: { fontSize: 11, textAlign: 'center', paddingHorizontal: spacing[1] },
  check: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  checkMark: { fontSize: 22 },
  checkLabel: { flex: 1, fontSize: 16, textAlign: 'auto' },
});
