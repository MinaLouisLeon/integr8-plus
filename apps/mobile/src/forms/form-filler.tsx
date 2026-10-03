import { touchKey } from '@integr8/form-engine';
import { entriesOf, entryTitle, say } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { useRef, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '~/components/ui';
import { AnswerList } from './answer-list';
import { EntryList, EntryView } from './entries';
import { FieldBlock } from './field-block';
import type { FillModel } from './fill-model';
import { FormMediaProvider } from './media';
import { ActionButton, Muted, Problem, TextBox } from './widgets/kit';

/**
 * A form, filled on the phone: the React Native renderer (P13).
 *
 * Laid out the way the builder's phone preview shows it — one page at a time,
 * in a single column — with what a small screen needs on top of that: a
 * progress bar, contents to jump to any page or section, a list of every
 * problem that jumps to each question, and a review of exactly what will be sent.
 * A repeatable section is a list of its entries, filled one entry at a time (P13b).
 *
 * Nothing here knows about any particular form; `FillModel` asks the engine.
 */

export interface FormFillerProps {
  model: FillModel;
  title: string;
  /** "WO-000042 · Boiler service" */
  subtitle: string | undefined;
  workOrderId: string | null;
  locale: string;
  today: string;
  /** A submitted form being corrected: a reason is asked for before it goes. */
  correction: boolean;
  /** Shown once at the top, e.g. how many answers were filled from an earlier form. */
  notice: string | undefined;
  /** Records the submission. Location and reason are gathered here first. */
  onSubmit: (extra: { reason: string | undefined }) => Promise<void>;
  /** Leaves the form. Everything is already saved. */
  onClose: () => void;
}

export function FormFiller(props: FormFillerProps) {
  const {
    model,
    title,
    subtitle,
    workOrderId,
    locale,
    today,
    correction,
    notice,
    onSubmit,
    onClose,
  } = props;
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const theme = useTheme();
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot);
  const { view, pages, pageIndex, reviewing, problems } = snapshot;
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const questions = useRef(new Map<string, View>());
  const [contents, setContents] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const page = pages[pageIndex];

  const top = () => scroll.current?.scrollTo({ y: 0, animated: false });

  /** Scrolls to a question, once the page it is on has been drawn. */
  const reveal = (elementId: string) => {
    setTimeout(() => {
      const target = questions.current.get(elementId);
      const container = content.current;
      if (target === undefined || container === null) {
        return;
      }
      target.measureLayout(container, (_x, y) => {
        scroll.current?.scrollTo({ y: Math.max(0, y - spacing[4]), animated: true });
      });
    }, 50);
  };

  const goToField = (fieldId: string, entry?: string) => {
    model.goToField(fieldId, entry);
    reveal(touchKey(fieldId, entry));
  };

  const review = () => {
    const result = model.review();
    if (result.ok) {
      top();
      return;
    }
    const count = model.snapshot().problems.length;
    AccessibilityInfo.announceForAccessibility(t('fill.summary.title', { count }));
    top();
  };

  const submit = async () => {
    if (correction && reason.trim() === '') {
      setReasonMissing(true);
      return;
    }
    setSubmitting(true);
    setFailure(undefined);
    try {
      await onSubmit({ reason: correction ? reason.trim() : undefined });
    } catch (error) {
      setFailure(
        t('mobile.fill.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const register = (id: string) => (node: View | null) => {
    if (node === null) {
      questions.current.delete(id);
    } else {
      questions.current.set(id, node);
    }
  };

  const progressLabel =
    view.progress.requiredTotal === 0 ||
    view.progress.requiredAnswered === view.progress.requiredTotal
      ? t('fill.nav.complete')
      : t('fill.nav.progress', {
          answered: view.progress.requiredAnswered,
          total: view.progress.requiredTotal,
        });

  return (
    <FormMediaProvider
      workOrderId={workOrderId}
      answers={snapshot.state.answers}
      settled={() => model.flush()}
    >
      <KeyboardAvoidingView
        style={[styles.screen, { backgroundColor: theme.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View
          style={[
            styles.header,
            {
              borderBottomColor: theme.border,
              backgroundColor: theme.surface,
              paddingTop: insets.top + spacing[3],
            },
          ]}
        >
          <View style={styles.headerRow}>
            <ActionButton tone="quiet" label={t('mobile.back')} onPress={onClose} />
            <View style={styles.grow}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                {title}
              </Text>
              {subtitle === undefined ? null : <Muted>{subtitle}</Muted>}
            </View>
            <ActionButton label={t('mobile.fill.contents')} onPress={() => setContents(true)} />
          </View>
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={progressLabel}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(snapshot.progress * 100) }}
            style={[styles.track, { backgroundColor: theme.surfaceMuted }]}
          >
            <View
              style={[
                styles.fill,
                {
                  backgroundColor: theme.accent,
                  width: `${String(Math.round(snapshot.progress * 100))}%` as `${number}%`,
                },
              ]}
            />
          </View>
          <View style={styles.headerRow}>
            <Muted>{progressLabel}</Muted>
            <Muted>
              {snapshot.saveStatus === 'failed'
                ? t('submissions.detail.saveFailed')
                : snapshot.saveStatus === 'saving'
                  ? t('submissions.detail.saving')
                  : t('mobile.fill.saved')}
            </Muted>
          </View>
        </View>

        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing[16] }]}
        >
          <View ref={content} collapsable={false} style={styles.content}>
            {notice === undefined ? null : (
              <View style={[styles.notice, { backgroundColor: theme.accentSubtle }]}>
                <Text style={[styles.noticeText, { color: theme.text }]}>{notice}</Text>
              </View>
            )}
            {correction ? <Muted>{t('mobile.fill.correcting')}</Muted> : null}

            {problems.length === 0 ? null : (
              <View
                accessibilityRole="alert"
                style={[
                  styles.problems,
                  { borderColor: theme.danger, backgroundColor: theme.dangerSubtle },
                ]}
              >
                <Text style={[styles.problemsTitle, { color: theme.text }]}>
                  {t('fill.summary.title', { count: problems.length })}
                </Text>
                {problems.map((problem) => {
                  const element = model.form.elements.get(problem.field);
                  const field = element?.field;
                  const named =
                    field === undefined
                      ? say(model.definitionSection(problem.field)?.title, locale) || problem.field
                      : say(field.label, locale) || field.id;
                  const section =
                    element?.entries === undefined
                      ? undefined
                      : model.definitionSection(element.entries);
                  const entries = section === undefined ? [] : entriesOf(view, section.id);
                  const at = entries.findIndex((entry) => entry.id === problem.entry);
                  const question =
                    section === undefined || at === -1
                      ? named
                      : t('mobile.fill.entries.problem', {
                          question: named,
                          entry: entryTitle(section, entries[at]!, at, locale).label,
                        });
                  return (
                    <Pressable
                      key={touchKey(problem.field, problem.entry)}
                      accessibilityRole="link"
                      onPress={() => goToField(problem.field, problem.entry)}
                      style={styles.problemLink}
                    >
                      <Text style={[styles.problemText, { color: theme.danger }]}>
                        {t('fill.summary.goTo', { question })}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {reviewing ? (
              <View style={styles.content}>
                <Text accessibilityRole="header" style={[styles.pageTitle, { color: theme.text }]}>
                  {t('fill.review.title')}
                </Text>
                <Muted>{t('fill.review.intro')}</Muted>
                <AnswerList
                  form={model.form}
                  answers={snapshot.state.answers}
                  locale={locale}
                  today={today}
                  onChangePage={(pageId) => {
                    const index = pages.findIndex((candidate) => candidate.id === pageId);
                    model.goToPage(index === -1 ? 0 : index);
                    top();
                  }}
                />
                {correction ? (
                  <View style={styles.reason}>
                    <Text style={[styles.label, { color: theme.text }]}>
                      {t('fill.review.reason')}
                    </Text>
                    <Muted>{t('fill.review.reasonHint')}</Muted>
                    <TextBox
                      accessibilityLabel={t('fill.review.reason')}
                      value={reason}
                      invalid={reasonMissing}
                      multiline
                      maxLength={2000}
                      onChangeText={(typed) => {
                        setReason(typed);
                        setReasonMissing(false);
                      }}
                    />
                    {reasonMissing ? <Problem>{t('fill.review.reasonRequired')}</Problem> : null}
                  </View>
                ) : null}
                {failure === undefined ? null : <Problem>{failure}</Problem>}
                <View style={styles.actions}>
                  <ActionButton
                    label={t('fill.actions.edit')}
                    onPress={() => {
                      model.edit();
                      top();
                    }}
                  />
                  <ActionButton
                    tone="primary"
                    label={
                      correction ? t('fill.actions.submitCorrection') : t('fill.actions.submit')
                    }
                    busy={submitting}
                    onPress={() => void submit()}
                  />
                </View>
              </View>
            ) : page === undefined ? null : (
              <View style={styles.content}>
                <View>
                  {pages.length > 1 ? (
                    <Muted>
                      {t('mobile.fill.pageOf', { number: pageIndex + 1, total: pages.length })}
                    </Muted>
                  ) : null}
                  {pages.length > 1 || page.title !== undefined ? (
                    <Text
                      accessibilityRole="header"
                      style={[styles.pageTitle, { color: theme.text }]}
                    >
                      {say(page.title, locale) || t('fill.nav.page', { number: pageIndex + 1 })}
                    </Text>
                  ) : null}
                </View>

                {snapshot.openEntry !== undefined ? (
                  <EntryView
                    key={snapshot.openEntry.entry}
                    model={model}
                    snapshot={snapshot}
                    section={model.definitionSection(snapshot.openEntry.section)!}
                    entryId={snapshot.openEntry.entry}
                    locale={locale}
                    register={register}
                    onMoved={top}
                  />
                ) : null}

                {page.sections
                  .filter(
                    (section) =>
                      snapshot.openEntry === undefined && view.visible.get(section.id) === true,
                  )
                  .map((section) => (
                    <View
                      key={section.id}
                      ref={register(section.id)}
                      collapsable={false}
                      style={[
                        styles.section,
                        { borderColor: theme.border, backgroundColor: theme.surface },
                      ]}
                    >
                      {section.title === undefined ? null : (
                        <Text
                          accessibilityRole="header"
                          style={[styles.sectionTitle, { color: theme.text }]}
                        >
                          {say(section.title, locale)}
                        </Text>
                      )}
                      {section.repeat !== undefined ? (
                        <EntryList
                          model={model}
                          snapshot={snapshot}
                          section={section}
                          locale={locale}
                        />
                      ) : null}
                      {section.fields
                        .filter(
                          (field) =>
                            section.repeat === undefined && view.visible.get(field.id) === true,
                        )
                        .map((field) => (
                          <FieldBlock
                            key={field.id}
                            ref={register(field.id)}
                            field={field}
                            value={view.values.get(field.id) ?? snapshot.state.answers[field.id]}
                            errors={view.shownErrors.filter((error) => error.field === field.id)}
                            locale={locale}
                            disabled={false}
                            onAnswer={(value) => model.answer(field.id, value)}
                            onClear={() => model.clear(field.id)}
                            onBlur={() => model.touch(field.id)}
                          />
                        ))}
                    </View>
                  ))}

                <View
                  style={[styles.actions, snapshot.openEntry === undefined ? null : styles.hidden]}
                >
                  <ActionButton
                    label={t('fill.actions.back')}
                    disabled={pageIndex === 0}
                    onPress={() => {
                      model.back();
                      top();
                    }}
                  />
                  {pageIndex < pages.length - 1 ? (
                    <ActionButton
                      tone="primary"
                      label={t('fill.actions.next')}
                      onPress={() => {
                        model.next();
                        top();
                      }}
                    />
                  ) : (
                    <ActionButton
                      tone="primary"
                      label={t('fill.actions.review')}
                      onPress={review}
                    />
                  )}
                </View>
              </View>
            )}
          </View>
        </ScrollView>

        <Modal
          visible={contents}
          animationType="slide"
          transparent
          onRequestClose={() => setContents(false)}
        >
          <View style={styles.backdrop}>
            <View style={[styles.sheet, { backgroundColor: theme.background }]}>
              <Text accessibilityRole="header" style={[styles.pageTitle, { color: theme.text }]}>
                {t('mobile.fill.contents')}
              </Text>
              <ScrollView contentContainerStyle={styles.contents}>
                {pages.map((candidate, index) => {
                  const count = snapshot.problemsPerPage[index] ?? 0;
                  const current = !reviewing && index === pageIndex;
                  return (
                    <View key={candidate.id} style={styles.contentsPage}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: current }}
                        onPress={() => {
                          model.goToPage(index);
                          setContents(false);
                          top();
                        }}
                        style={[
                          styles.contentsRow,
                          {
                            backgroundColor: current ? theme.accentSubtle : theme.surface,
                            borderColor: current ? theme.accent : theme.border,
                          },
                        ]}
                      >
                        <Text style={[styles.contentsLabel, { color: theme.text }]}>
                          {say(candidate.title, locale) ||
                            t('fill.nav.page', { number: index + 1 })}
                        </Text>
                        {count === 0 ? null : (
                          <Text
                            style={[
                              styles.badge,
                              { color: theme.danger, backgroundColor: theme.dangerSubtle },
                            ]}
                          >
                            {t('fill.nav.problems', { count })}
                          </Text>
                        )}
                      </Pressable>
                      {candidate.sections
                        .filter(
                          (section) =>
                            view.visible.get(section.id) === true && section.title !== undefined,
                        )
                        .map((section) => (
                          <Pressable
                            key={section.id}
                            accessibilityRole="button"
                            onPress={() => {
                              model.goToPage(index);
                              setContents(false);
                              reveal(section.id);
                            }}
                            style={styles.contentsSection}
                          >
                            <Text style={[styles.contentsSectionLabel, { color: theme.textMuted }]}>
                              {say(section.title, locale)}
                            </Text>
                          </Pressable>
                        ))}
                    </View>
                  );
                })}
              </ScrollView>
              <ActionButton label={t('mobile.fill.close')} onPress={() => setContents(false)} />
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </FormMediaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  header: {
    gap: spacing[2],
    borderBottomWidth: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[3],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  title: { fontSize: fontSize.xl, fontWeight: '700', textAlign: 'auto' },
  track: { height: 8, borderRadius: radii.full, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radii.full },
  scroll: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
    paddingBottom: spacing[16],
  },
  content: { gap: spacing[4] },
  notice: { borderRadius: radii.md, padding: spacing[3] },
  noticeText: { fontSize: fontSize.base, textAlign: 'auto' },
  problems: { gap: spacing[2], borderWidth: 1.5, borderRadius: radii.lg, padding: spacing[4] },
  problemsTitle: { fontSize: fontSize.lg, fontWeight: '700', textAlign: 'auto' },
  problemLink: { minHeight: 44, justifyContent: 'center' },
  problemText: {
    fontSize: fontSize.base,
    fontWeight: '600',
    textDecorationLine: 'underline',
    textAlign: 'auto',
  },
  pageTitle: { fontSize: fontSize['2xl'], fontWeight: '700', textAlign: 'auto' },
  section: { gap: spacing[5], borderWidth: 1, borderRadius: radii.lg, padding: spacing[4] },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '700', textAlign: 'auto' },
  label: { fontSize: fontSize.lg, fontWeight: '600', textAlign: 'auto' },
  reason: { gap: spacing[2] },
  actions: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3] },
  hidden: { display: 'none' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  sheet: {
    maxHeight: '85%',
    gap: spacing[3],
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
  contents: { gap: spacing[3] },
  contentsPage: { gap: spacing[1] },
  contentsRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
  },
  contentsLabel: { flex: 1, fontSize: fontSize.lg, fontWeight: '600', textAlign: 'auto' },
  badge: {
    overflow: 'hidden',
    borderRadius: radii.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  contentsSection: { minHeight: 44, justifyContent: 'center', paddingStart: spacing[6] },
  contentsSectionLabel: { fontSize: fontSize.base, textAlign: 'auto' },
});
