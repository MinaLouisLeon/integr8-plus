import {
  type FieldError,
  isAnswered,
  type Section,
  storedEntries,
  touchKey,
} from '@integr8/form-engine';
import {
  canAddEntry,
  entriesOf,
  entryErrors,
  entryTitle,
  firstPerField,
  say,
  sectionErrors,
} from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import type { View as ViewType } from 'react-native';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import { FieldBlock } from './field-block';
import type { FillModel, FillSnapshot } from './fill-model';
import { ActionButton, Muted, Problem } from './widgets/kit';

/**
 * A repeatable section on the phone (P13b): a list of its entries, then one
 * entry at a time — every appliance, every radiator — sized for one hand.
 *
 * The list says what each entry is ("Radiator 2 · Hall") and which need
 * attention. Adding an entry opens it; an open entry shows only its own
 * questions, with the way to the next one, to move it, and to remove it.
 */

type Register = (key: string) => (node: ViewType | null) => void;

/** "Radiator 2 · Hall", or "Radiator 2" before the room is answered. */
function titleOf(title: { label: string; name: string | undefined }): string {
  return title.name === undefined ? title.label : `${title.label} · ${title.name}`;
}

export function EntryList({
  model,
  snapshot,
  section,
  locale,
}: {
  model: FillModel;
  snapshot: FillSnapshot;
  section: Section;
  locale: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { view } = snapshot;
  const entries = entriesOf(view, section.id);
  const entryLabel = say(section.repeat?.entryLabel, locale);
  const own = sectionErrors(view.shownErrors, section.id);
  const translate = t as unknown as (key: string, params: Record<string, string>) => string;

  return (
    <View style={styles.list}>
      {entries.length === 0 ? <Muted>{t('mobile.fill.entries.none')}</Muted> : null}
      {entries.map((entry, index) => {
        const title = titleOf(entryTitle(section, entry, index, locale));
        const problems = firstPerField(entryErrors(view.shownErrors, entry.id)).length;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityLabel={
              problems === 0 ? title : `${title}, ${t('fill.nav.problems', { count: problems })}`
            }
            accessibilityHint={t('mobile.fill.entries.openHint')}
            onPress={() => model.openEntry({ section: section.id, entry: entry.id })}
            style={({ pressed }) => [
              styles.row,
              {
                borderColor: problems > 0 ? theme.danger : theme.borderStrong,
                backgroundColor: theme.background,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
            {problems === 0 ? null : (
              <Text
                style={[styles.badge, { color: theme.danger, backgroundColor: theme.dangerSubtle }]}
              >
                {t('fill.nav.problems', { count: problems })}
              </Text>
            )}
            <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text>
          </Pressable>
        );
      })}
      {own.map((error) => (
        <Problem key={error.code}>
          {translate(`form.errors.${error.code}`, { ...error.params })}
        </Problem>
      ))}
      {canAddEntry(section, view) ? (
        <ActionButton
          label={t('mobile.fill.entries.add', { entry: entryLabel })}
          onPress={() => {
            model.addEntry(section.id);
          }}
        />
      ) : (
        <Muted>{t('mobile.fill.entries.full', { count: section.repeat?.maxEntries ?? 0 })}</Muted>
      )}
    </View>
  );
}

export function EntryView({
  model,
  snapshot,
  section,
  entryId,
  locale,
  register,
  onMoved,
}: {
  model: FillModel;
  snapshot: FillSnapshot;
  section: Section;
  entryId: string;
  locale: string;
  register: Register;
  /** After leaving the entry or going to another, so the screen can scroll to the top. */
  onMoved: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { view, state } = snapshot;
  const entries = entriesOf(view, section.id);
  const index = entries.findIndex((entry) => entry.id === entryId);
  const entry = entries[index];
  if (entry === undefined) {
    return null;
  }
  const stored = storedEntries(state.answers, section.id).find(
    (candidate) => candidate.id === entryId,
  );
  const title = titleOf(entryTitle(section, entry, index, locale));
  const go = (next: number) => {
    const target = entries[next];
    if (target !== undefined) {
      model.openEntry({ section: section.id, entry: target.id });
      onMoved();
    }
  };
  const remove = () => {
    const hasAnswers = entryHasAnswers(stored?.values ?? {}, section);
    const confirmRemove = () => {
      model.removeEntry(section.id, entryId);
      onMoved();
    };
    if (!hasAnswers) {
      confirmRemove();
      return;
    }
    Alert.alert(
      t('mobile.fill.entries.removeTitle', { entry: title }),
      t('mobile.fill.entries.removeBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('mobile.fill.entries.remove'), style: 'destructive', onPress: confirmRemove },
      ],
    );
  };
  const errorsFor = (field: string): FieldError[] =>
    view.shownErrors.filter((error) => error.field === field && error.entry === entryId);

  return (
    <View style={styles.entry}>
      <ActionButton
        tone="quiet"
        label={t('mobile.fill.entries.back', {
          section: say(section.title, locale) || say(section.repeat?.entryLabel, locale),
        })}
        onPress={() => {
          model.openEntry(undefined);
          onMoved();
        }}
      />
      <View>
        <Muted>
          {t('mobile.fill.entries.position', { number: index + 1, total: entries.length })}
        </Muted>
        <Text accessibilityRole="header" style={[styles.entryTitle, { color: theme.text }]}>
          {title}
        </Text>
      </View>

      <View style={[styles.fields, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        {section.fields
          .filter((field) => entry.visible.get(field.id) === true)
          .map((field) => (
            <FieldBlock
              key={field.id}
              ref={register(touchKey(field.id, entryId))}
              field={field}
              value={entry.values.get(field.id) ?? stored?.values[field.id]}
              errors={errorsFor(field.id)}
              locale={locale}
              disabled={false}
              onAnswer={(value) => model.answer(field.id, value, entryId)}
              onClear={() => model.clear(field.id, entryId)}
              onBlur={() => model.touch(field.id, entryId)}
            />
          ))}
      </View>

      <View style={styles.actions}>
        <ActionButton
          label={t('mobile.fill.entries.previous')}
          disabled={index === 0}
          onPress={() => go(index - 1)}
        />
        {index < entries.length - 1 ? (
          <ActionButton
            tone="primary"
            label={t('mobile.fill.entries.next')}
            onPress={() => go(index + 1)}
          />
        ) : (
          <ActionButton
            tone="primary"
            label={t('mobile.fill.entries.done')}
            onPress={() => {
              model.openEntry(undefined);
              onMoved();
            }}
          />
        )}
      </View>
      <View style={styles.actions}>
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.moveUp')}
          disabled={index === 0}
          onPress={() => model.moveEntry(section.id, entryId, index - 1)}
        />
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.entries.moveDown')}
          disabled={index === entries.length - 1}
          onPress={() => model.moveEntry(section.id, entryId, index + 1)}
        />
        <ActionButton tone="quiet" label={t('mobile.fill.entries.remove')} onPress={remove} />
      </View>
    </View>
  );
}

/** Whether an entry holds any answer: an empty one is removed without asking. */
export function entryHasAnswers(
  values: Readonly<Record<string, unknown>>,
  section: Section,
): boolean {
  return section.fields.some((field) => isAnswered(field, values[field.id]));
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowTitle: { flex: 1, fontSize: fontSize.lg, fontWeight: '600', textAlign: 'auto' },
  chevron: { fontSize: fontSize['2xl'] },
  badge: {
    overflow: 'hidden',
    borderRadius: radii.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  entry: { gap: spacing[4] },
  entryTitle: { fontSize: fontSize['2xl'], fontWeight: '700', textAlign: 'auto' },
  fields: { gap: spacing[5], borderWidth: 1, borderRadius: radii.lg, padding: spacing[4] },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
});
