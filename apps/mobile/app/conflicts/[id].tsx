import { useTranslation } from '@integr8/i18n';
import {
  type Choice,
  changesNeedingAttention,
  describeChanges,
  discardChange,
  resolveAccessConflict,
  resolveAnswersConflict,
  retryChange,
} from '@integr8/offline';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  Body,
  Button,
  EmptyState,
  Heading,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { describeChange, describeValue, missingLines } from '~/lib/describe-change';
import { formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';

/**
 * Deciding about one change that could not be sent as it was (P12).
 *
 * Both versions are shown in the engineer's terms — the job's state and who
 * moved it, each access note side by side, each disputed answer side by side —
 * and nothing happens until they choose. The server's version is never
 * overwritten by default, and the engineer's is never dropped without asking.
 */
export default function ConflictScreen() {
  return (
    <LocalGate>
      <Conflict />
    </LocalGate>
  );
}

function Conflict() {
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const state = useLocalQuery(
    `conflict:${id}`,
    ['outbox', 'work_orders', 'submissions', 'sites'],
    async (sql) =>
      (await describeChanges(sql, await changesNeedingAttention(sql))).find(
        (change) => change.id === id,
      ),
  );

  if (state.status !== 'ready') {
    return <ScrollScreen>{null}</ScrollScreen>;
  }
  const change = state.data;
  if (change === undefined) {
    return (
      <ScrollScreen>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        <EmptyState title={t('mobile.syncScreen.nothing')} body="" />
      </ScrollScreen>
    );
  }

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      void localData.sync('manual');
      router.back();
    } finally {
      setBusy(false);
    }
  };
  const context = localData.changeContext();
  if (context === undefined) {
    return <ScrollScreen>{null}</ScrollScreen>;
  }
  const keepTheirs = () =>
    Alert.alert(t('mobile.syncScreen.discardTitle'), t('mobile.syncScreen.discardBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('mobile.conflict.keepTheirs'),
        style: 'destructive',
        onPress: () => void act(() => discardChange(context, change.id)),
      },
    ]);

  const conflict = change.conflict;
  const mineState =
    change.kind === 'work_order.transition'
      ? t(`operations.state.${change.payload.to as 'complete'}`)
      : '';

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>
      <Heading>{t('mobile.conflict.title')}</Heading>
      <Body>{describeChange(t, change)}</Body>

      {conflict === null ? (
        <>
          <Body>{t('mobile.conflict.refused', { message: change.lastError?.message ?? '' })}</Body>
          <Button
            label={t('mobile.syncScreen.retry')}
            busy={busy}
            onPress={() => void act(() => retryChange(context, change.id))}
          />
          <Button label={t('mobile.syncScreen.discard')} variant="secondary" onPress={keepTheirs} />
        </>
      ) : conflict.kind === 'state_changed' ? (
        <>
          <Body>
            {t(
              conflict.current.changedBy === null
                ? 'mobile.conflict.stateChangedNobody'
                : 'mobile.conflict.stateChanged',
              {
                who: conflict.current.changedBy?.name ?? '',
                state: t(`operations.state.${conflict.current.state}`),
                reason:
                  conflict.current.reason === null
                    ? ''
                    : t('mobile.conflict.reason', { reason: conflict.current.reason }),
                mine: mineState,
              },
            )}
          </Body>
          <Body muted>{formatWhen(conflict.current.changedAt, i18n.language)}</Body>
          {conflict.canReapply ? (
            <Button
              label={t('mobile.conflict.reapply', { mine: mineState })}
              busy={busy}
              onPress={() => void act(() => retryChange(context, change.id))}
            />
          ) : (
            <Body muted>
              {t('mobile.conflict.cannotReapply', {
                state: t(`operations.state.${conflict.current.state}`),
                mine: mineState,
              })}
            </Body>
          )}
          <Button
            label={t('mobile.conflict.keepTheirs')}
            variant="secondary"
            onPress={keepTheirs}
          />
        </>
      ) : conflict.kind === 'incomplete' ? (
        <>
          <Body>{t('mobile.conflict.incomplete')}</Body>
          {missingLines(t, conflict.missing).map((line) => (
            <Body key={line}>{`• ${line}`}</Body>
          ))}
          {change.workOrderId === null ? null : (
            <Button
              label={t('mobile.conflict.openJob')}
              variant="secondary"
              onPress={() =>
                router.push({ pathname: '/jobs/[id]', params: { id: change.workOrderId! } })
              }
            />
          )}
          <Button
            label={t('mobile.syncScreen.retry')}
            busy={busy}
            onPress={() => void act(() => retryChange(context, change.id))}
          />
          <Button label={t('mobile.syncScreen.discard')} variant="secondary" onPress={keepTheirs} />
        </>
      ) : conflict.kind === 'already_submitted' ? (
        <>
          <Body>
            {t('mobile.conflict.alreadySubmitted', { who: conflict.current.submittedBy.name })}
          </Body>
          <Button
            label={t('mobile.conflict.keepTheirs')}
            variant="secondary"
            onPress={keepTheirs}
          />
        </>
      ) : (
        <>
          <Body>
            {conflict.kind === 'access_changed'
              ? t('mobile.conflict.accessChanged')
              : t('mobile.conflict.answersChanged')}
          </Body>
          {(conflict.kind === 'access_changed'
            ? conflict.fields.map((field) => ({
                key: field.field,
                label: t(`mobile.conflict.field.${field.field}`),
                base: field.base,
                mine: field.mine,
                theirs: field.theirs,
              }))
            : conflict.questions.map((question) => ({
                key: question.id,
                label: question.id,
                base: question.base,
                mine: question.mine,
                theirs: question.theirs,
              }))
          ).map((item) => (
            <Section key={item.key} title={item.label}>
              <Body muted>
                {t('mobile.conflict.before', { value: describeValue(t, item.base) })}
              </Body>
              <Choices
                theirs={describeValue(t, item.theirs)}
                mine={describeValue(t, item.mine)}
                value={choices[item.key]}
                onChange={(choice) => setChoices((current) => ({ ...current, [item.key]: choice }))}
              />
            </Section>
          ))}
          <Button
            label={t('mobile.conflict.useChoices')}
            busy={busy}
            onPress={() =>
              void act(() =>
                conflict.kind === 'access_changed'
                  ? resolveAccessConflict(context, change.id, choices)
                  : resolveAnswersConflict(context, change.id, choices),
              )
            }
          />
          <Button
            label={t('mobile.conflict.keepTheirs')}
            variant="secondary"
            onPress={keepTheirs}
          />
        </>
      )}
    </ScrollScreen>
  );
}

function Choices({
  theirs,
  mine,
  value,
  onChange,
}: {
  theirs: string;
  mine: string;
  value: Choice | undefined;
  onChange: (choice: Choice) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={styles.choices}>
      {(
        [
          ['theirs', t('mobile.conflict.theirs'), theirs],
          ['mine', t('mobile.conflict.mine'), mine],
        ] as const
      ).map(([choice, label, text]) => {
        const selected = (value ?? 'theirs') === choice;
        return (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(choice)}
            style={[
              styles.choice,
              {
                borderColor: selected ? theme.accent : theme.border,
                backgroundColor: theme.surface,
              },
            ]}
          >
            <Text style={[styles.choiceLabel, { color: theme.textMuted }]}>{label}</Text>
            <Text style={[styles.choiceValue, { color: theme.text }]}>{text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', gap: spacing[2] },
  choice: { flex: 1, gap: spacing[1], borderWidth: 2, borderRadius: radii.md, padding: spacing[3] },
  choiceLabel: { fontSize: fontSize.xs, fontWeight: '600', textAlign: 'auto' },
  choiceValue: { fontSize: fontSize.base, textAlign: 'auto' },
});
