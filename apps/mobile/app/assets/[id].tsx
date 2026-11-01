import { ASSET_CONDITIONS } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import {
  type AssetTimelineEntry,
  type ConditionValue,
  assetFilesIn,
  jobForms,
  localAsset,
} from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { openStarted } from '~/components/job-forms';
import { AssetRow } from '~/components/job-assets';
import { LocalGate } from '~/components/local-gate';
import {
  Body,
  Button,
  Detail,
  Field,
  Heading,
  NotReadyScreen,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { formatWhen } from '~/lib/format';
import { assetStart, liveNeedsNewerApp, startForm } from '~/forms/session';
import { linkAsset, openAssetFile, recordCondition } from '~/local/job-actions';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';
import { refusalMessage } from '~/lib/refusals';

/** How much history shows at first, and how much more each "Show older" adds (Low 14). */
const TIMELINE_PAGE = 50;

/**
 * One asset on the phone (CRM/ERP plan, phase E3; ADR-0008): what it is,
 * where, and everything ever done to it, newest first, from the phone's own
 * copy — so a scanned tag in a plant room opens with no signal. The history
 * shows its newest fifty entries, and older ones fifty at a time. Recording its
 * condition, and linking it to the job it was opened from, are sent with the
 * job.
 */
export default function AssetScreen() {
  return (
    <LocalGate>
      <Asset />
    </LocalGate>
  );
}

function Asset() {
  const { t, i18n } = useTranslation();
  const { id, workOrderId } = useLocalSearchParams<{ id: string; workOrderId?: string }>();
  const state = useLocalQuery(`asset:${id}`, ['assets', 'asset_links'], (sql) =>
    localAsset(sql, id),
  );
  // Opened from a job: that job's forms not started yet can be filled for this asset.
  const forms = useLocalQuery(
    `asset-forms:${id}:${workOrderId ?? ''}`,
    ['work_orders', 'submissions', 'forms', 'outbox'],
    async (sql) =>
      workOrderId === undefined
        ? []
        : (await jobForms(sql, workOrderId)).filter(
            (form) => form.submission === null && form.liveVersionId !== null,
          ),
  );
  const [condition, setCondition] = useState<ConditionValue | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(TIMELINE_PAGE);

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  const back = (
    <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
  );
  const asset = state.data;
  if (asset === undefined) {
    return (
      <ScrollScreen>
        {back}
        <Body>{t('mobile.assets.notOnPhone')}</Body>
      </ScrollScreen>
    );
  }
  const { data } = asset;
  const linkedHere = workOrderId === undefined || asset.workOrderIds.includes(workOrderId);
  const failed = (error: unknown) =>
    Alert.alert(t('mobile.assets.failed'), refusalMessage(t, error, ''));

  const save = () => {
    if (condition === null) {
      return;
    }
    setBusy(true);
    recordCondition({
      assetId: data.asset.id,
      condition,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      ...(workOrderId === undefined ? {} : { workOrderId }),
    })
      .then(() => {
        setCondition(null);
        setNote('');
      })
      .catch(failed)
      .finally(() => setBusy(false));
  };

  return (
    <ScrollScreen>
      {back}
      <View style={{ gap: spacing[1] }}>
        <Heading>
          {data.asset.reference === '' ? t('mobile.assets.notYetNumbered') : data.asset.reference} ·{' '}
          {data.asset.name}
        </Heading>
        <Body muted>
          {data.asset.customer.name} · {data.asset.site.name}
          {data.asset.locationNote === null ? '' : ` · ${data.asset.locationNote}`}
        </Body>
      </View>
      <AssetRow asset={asset} />

      {!linkedHere && workOrderId !== undefined && data.asset.status !== 'retired' ? (
        <Button
          label={t('mobile.assets.linkToJob')}
          onPress={() => {
            linkAsset({ workOrderId, assetId: data.asset.id }).catch(failed);
          }}
        />
      ) : null}

      {linkedHere &&
      workOrderId !== undefined &&
      data.asset.status !== 'retired' &&
      forms.status === 'ready' &&
      forms.data.length > 0 ? (
        <Section title={t('mobile.assets.fillFor')}>
          {forms.data.map((form) => (
            <Button
              key={form.formId}
              label={form.title}
              variant="secondary"
              disabled={busy}
              onPress={() => {
                const context = localData.changeContext();
                if (context === undefined) {
                  return;
                }
                setBusy(true);
                void assetStart(context, { form, workOrderId, assetId: data.asset.id })
                  .then(async (start) => {
                    if (await liveNeedsNewerApp(context, form)) {
                      Alert.alert(t('fill.updateApp.title'), t('fill.updateApp.body'));
                      return;
                    }
                    const submissionId = await startForm(context, {
                      form,
                      workOrderId,
                      startFrom: undefined,
                      asset: start,
                    });
                    if (start === undefined) {
                      router.push({ pathname: '/forms/[id]', params: { id: submissionId } });
                    } else {
                      openStarted(submissionId, start);
                    }
                  })
                  .catch(failed)
                  .finally(() => setBusy(false));
              }}
            />
          ))}
        </Section>
      ) : null}

      <Section title={t('mobile.assets.details')}>
        {data.asset.make === null && data.asset.model === null ? null : (
          <Detail label={t('assets.fields.model')}>
            {[data.asset.make, data.asset.model].filter((part) => part !== null).join(' ')}
          </Detail>
        )}
        {data.asset.serialNumber === null ? null : (
          <Detail label={t('assets.fields.serialNumber')}>{data.asset.serialNumber}</Detail>
        )}
        {data.asset.installDate === null ? null : (
          <Detail label={t('assets.fields.installDate')}>
            {formatCalendarDate(data.asset.installDate, { locale: i18n.language })}
          </Detail>
        )}
        {data.asset.warrantyExpiresOn === null ? null : (
          <Detail label={t('assets.fields.warrantyExpiresOn')}>
            {formatCalendarDate(data.asset.warrantyExpiresOn, { locale: i18n.language })}
          </Detail>
        )}
        {data.asset.notes === null ? null : (
          <Detail label={t('assets.fields.notes')}>{data.asset.notes}</Detail>
        )}
      </Section>

      {data.can.record && data.asset.status !== 'retired' ? (
        <Section title={t('assets.recordCondition')}>
          <View style={styles.choices}>
            {ASSET_CONDITIONS.map((candidate) => (
              <Choice
                key={candidate}
                label={t(`assets.condition.${candidate}`)}
                chosen={condition === candidate}
                onPress={() => setCondition(candidate)}
              />
            ))}
          </View>
          <Field label={t('assets.note')} value={note} onChangeText={setNote} multiline />
          <Button
            label={busy ? t('assets.saving') : t('assets.save')}
            disabled={condition === null || busy}
            onPress={save}
          />
        </Section>
      ) : null}

      <Section title={t('assets.timeline')}>
        {data.timeline.length === 0 ? <Body muted>{t('assets.noHistory')}</Body> : null}
        {data.timeline.slice(0, shown).map((entry) => (
          <HistoryItem
            key={`${entry.kind}-${entry.id}`}
            entry={entry}
            siteId={data.asset.site.id}
          />
        ))}
        {data.timeline.length > shown ? (
          <Button
            label={t('assets.timelinePages.showOlder')}
            variant="secondary"
            onPress={() => setShown((count) => count + TIMELINE_PAGE)}
          />
        ) : null}
      </Section>
      {assetFilesIn(data).length === 0 ? null : <Body muted>{t('mobile.assets.filesHint')}</Body>}
    </ScrollScreen>
  );
}

function Choice({
  label,
  chosen,
  onPress,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          borderColor: chosen ? theme.accent : theme.border,
          backgroundColor: chosen ? theme.accent : theme.surface,
        },
      ]}
    >
      <Text style={{ color: chosen ? theme.onAccent : theme.text, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One line of history, in words, with who and when, and its files to open. */
function HistoryItem({ entry, siteId }: { entry: AssetTimelineEntry; siteId: string }) {
  const { t, i18n } = useTranslation();
  const when = formatWhen(entry.at, i18n.language);
  const open = (file: { fileId: string; title: string; contentType: string; byteSize: number }) => {
    openAssetFile(siteId, file)
      .then((opened) => {
        if (!opened) {
          Alert.alert(file.title, t('mobile.files.unavailable'));
        }
      })
      .catch(() => Alert.alert(file.title, t('mobile.files.unavailable')));
  };
  let what = '';
  let who = '';
  let extra: string | null = null;
  const files: { fileId: string; title: string; contentType: string; byteSize: number }[] = [];
  switch (entry.kind) {
    case 'event':
      who = entry.event.by.name;
      what =
        entry.event.kind === 'condition_recorded'
          ? t('assets.events.condition_recorded', {
              condition: t(`assets.condition.${entry.event.condition ?? 'good'}`),
            })
          : entry.event.kind === 'status_changed'
            ? t('assets.events.status_changed', {
                from: t(`assets.status.${entry.event.fromStatus ?? 'active'}`),
                to: t(`assets.status.${entry.event.toStatus ?? 'active'}`),
              })
            : entry.event.kind === 'relocated'
              ? t('assets.events.relocated', {
                  site: entry.event.fromSite?.name ?? '',
                  customer: entry.event.fromSite?.customer.name ?? '',
                })
              : entry.event.kind === 'updated'
                ? t('assets.events.updated', {
                    fields: Object.keys(entry.event.changes ?? {})
                      .map((field) => t(`assets.fields.${field}` as 'assets.fields.name'))
                      .join(', '),
                  })
                : t(`assets.events.${entry.event.kind}`);
      extra = entry.event.note;
      break;
    case 'job':
      what = t('assets.entries.job', {
        reference: entry.workOrder.referenceLabel,
        title: entry.workOrder.title,
      });
      extra = t(`operations.state.${entry.workOrder.state}`);
      break;
    case 'submission':
      who = entry.submission.by.name;
      what = t('assets.entries.submission', { form: entry.submission.form.name });
      for (const photo of entry.submission.photos) {
        files.push({
          fileId: photo.mediaId,
          title: entry.submission.form.name,
          contentType: photo.contentType,
          byteSize: photo.byteSize,
        });
      }
      break;
    case 'part':
      who = entry.part.by.name;
      what = t('assets.entries.part', {
        quantity: entry.part.quantity,
        item: entry.part.item.name,
      });
      break;
    case 'attachment':
      who = entry.attachment.addedBy.name;
      what = t('assets.entries.attachment', { title: entry.attachment.title });
      files.push({
        fileId: entry.attachment.fileId,
        title: entry.attachment.title,
        contentType: entry.attachment.contentType,
        byteSize: entry.attachment.byteSize,
      });
      break;
  }
  return (
    <View style={styles.history}>
      <Body>{what}</Body>
      <Body muted>{who === '' ? when : t('assets.byOn', { name: who, date: when })}</Body>
      {extra === null ? null : <Body>{extra}</Body>}
      {files.length === 0 ? null : (
        <View style={styles.choices}>
          {files.map((file, index) => (
            <Button
              key={file.fileId}
              label={t('mobile.assets.openFile', { number: index + 1 })}
              variant="secondary"
              onPress={() => open(file)}
            />
          ))}
        </View>
      )}
    </View>
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
  history: { gap: spacing[1], paddingVertical: spacing[2] },
});
