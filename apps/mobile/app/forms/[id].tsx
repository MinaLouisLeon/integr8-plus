import { fillSession, type FillSession, recordAnswers } from '@integr8/offline';
import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import { Body, Button, EmptyState, Heading, ScrollScreen, useTheme } from '~/components/ui';
import { AnswerList } from '~/forms/answer-list';
import { submitLocation } from '~/forms/capture';
import { FillModel } from '~/forms/fill-model';
import { FormFiller } from '~/forms/form-filler';
import { FormMediaProvider } from '~/forms/media';
import { compiledVersion, localToday, submitForm } from '~/forms/session';
import { ActionButton } from '~/forms/widgets/kit';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';

/**
 * Filling one form, from the phone alone (P13). Everything it needs was
 * downloaded with the job; every change is saved on the phone as it is made;
 * submitting puts the form in the outbox, and the sync engine sends it when it
 * can — after the photos and signatures it names.
 */
export default function FillScreen() {
  return (
    <LocalGate>
      <Fill />
    </LocalGate>
  );
}

function Fill() {
  const { t } = useTranslation();
  const { id, prefilled, from } = useLocalSearchParams<{
    id: string;
    prefilled?: string;
    from?: string;
  }>();
  const state = useLocalQuery(
    `fill:${id}`,
    ['submissions', 'form_versions', 'forms', 'work_orders'],
    (sql) => fillSession(sql, id),
  );
  // The form is opened once, from what the phone held at that moment. Autosaves
  // write to the same rows this query watches; they must not reset what is on screen.
  const [opened, setOpened] = useState<FillSession | undefined>(undefined);
  if (opened === undefined && state.status === 'ready' && state.data !== undefined) {
    setOpened(state.data);
  }

  if (state.status !== 'ready') {
    return <ScrollScreen>{null}</ScrollScreen>;
  }
  if (opened?.definition === undefined) {
    return (
      <ScrollScreen>
        <View style={styles.back}>
          <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        </View>
        <EmptyState title={t('mobile.fill.notOnPhone')} body="" />
      </ScrollScreen>
    );
  }

  const notice =
    prefilled === undefined || from === undefined
      ? undefined
      : t('mobile.fill.start.prefilled', { count: Number(prefilled), job: from });
  return <Session session={opened} notice={notice} />;
}

function Session({ session, notice }: { session: FillSession; notice: string | undefined }) {
  const { t, i18n } = useTranslation();
  const form = compiledVersion(session.submission.formVersionId, session.definition);
  const [today] = useState(localToday);
  const subtitle =
    session.job === null
      ? undefined
      : t('mobile.fill.jobLine', { job: session.job.referenceLabel, title: session.job.title });

  const { page } = useLocalSearchParams<{ page?: string }>();
  const [model] = useState(() => {
    if (form === undefined) {
      return undefined;
    }
    const opened = new FillModel({
      form,
      answers: session.submission.answers,
      context: { today },
      save: async (answers) => {
        const context = localData.changeContext();
        if (context === undefined) {
          throw new Error('The phone’s database is not open.');
        }
        await recordAnswers(context, { submissionId: session.submission.id, answers });
      },
    });
    // Reopened after the app was closed: the page the engineer was on (P14).
    const resumed = Number(page);
    if (Number.isInteger(resumed) && resumed > 0) {
      opened.goToPage(Math.min(resumed, opened.snapshot().pages.length - 1));
    }
    return opened;
  });
  // The page in the route, so the screen remembered for a force close includes it.
  useEffect(
    () =>
      model?.subscribe(() => {
        const index = String(model.snapshot().pageIndex);
        if (index !== page) {
          router.setParams({ page: index });
        }
      }),
    [model, page],
  );

  if (form === undefined || model === undefined) {
    return (
      <ScrollScreen>
        <View style={styles.back}>
          <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        </View>
        <EmptyState title={t('mobile.fill.cannotOpen')} body="" />
      </ScrollScreen>
    );
  }

  if (session.submission.status === 'submitted') {
    return (
      <ScrollScreen>
        <View style={styles.back}>
          <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        </View>
        <Heading>{session.formTitle}</Heading>
        {subtitle === undefined ? null : <Body muted>{subtitle}</Body>}
        <Body>{t('mobile.fill.submittedBody')}</Body>
        <FormMediaProvider
          workOrderId={session.submission.workOrderId}
          answers={session.submission.answers}
          settled={() => Promise.resolve()}
        >
          <AnswerList
            form={form}
            answers={session.submission.answers}
            locale={i18n.language}
            today={today}
          />
        </FormMediaProvider>
      </ScrollScreen>
    );
  }

  return (
    <Submitting>
      {(locateThen) => (
        <FormFiller
          model={model}
          title={session.formTitle}
          subtitle={subtitle}
          workOrderId={session.submission.workOrderId}
          locale={i18n.language}
          today={today}
          correction={session.submission.status === 'reopened'}
          notice={notice}
          onClose={() => {
            void model.flush().finally(() => router.back());
          }}
          onSubmit={async ({ reason }) => {
            await model.flush();
            const location = await locateThen();
            const context = localData.changeContext();
            if (context === undefined) {
              throw new Error('The phone’s database is not open.');
            }
            await submitForm(context, {
              submissionId: session.submission.id,
              answers: model.submission(),
              today,
              reason,
              location,
            });
            void localData.sync('change');
            router.back();
          }}
        />
      )}
    </Submitting>
  );
}

/**
 * Where the phone is, taken as the form is submitted, with a sheet saying so —
 * and a way to submit without it. A plant room may never give a fix, and the
 * form matters more than the location.
 */
function Submitting({
  children,
}: {
  children: (locate: () => ReturnType<typeof submitLocation>) => ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [locating, setLocating] = useState(false);
  const [skip] = useState(() => new Skip());

  const locate = async () => {
    setLocating(true);
    try {
      return await submitLocation(skip.signal());
    } finally {
      setLocating(false);
    }
  };

  return (
    <>
      {children(locate)}
      <Modal visible={locating} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
              {t('mobile.fill.location.title')}
            </Text>
            <Body>{t('mobile.fill.location.body')}</Body>
            <ActionButton label={t('mobile.fill.location.skip')} onPress={() => skip.now()} />
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Lets "submit without it" stop waiting for a fix. */
class Skip {
  #controller = new AbortController();

  signal(): AbortSignal {
    this.#controller = new AbortController();
    return this.#controller.signal;
  }

  now(): void {
    this.#controller.abort();
  }
}

const styles = StyleSheet.create({
  back: { alignItems: 'flex-start' },
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing[6],
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
  },
  sheet: { gap: spacing[3], borderRadius: 12, padding: spacing[6] },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'auto' },
});
