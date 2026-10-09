import { ApiRequestError } from '@integr8/api-client';
import { type Answers, compileDefinition } from '@integr8/form-engine';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnswerView } from '../answer-view.js';
import { FormFiller, type SubmitOutcome } from '../form-filler.js';
import { buttonClass, inputClass } from '../widgets/types.js';
import {
  apiMediaAdapter,
  keys,
  localToday,
  problemsOf,
  type SubmissionDetail,
  useScreens,
} from './api.js';
import { BackLink, Dialog, Failure, Loading } from './parts.js';

/**
 * One submission: filled in, read back, or corrected — and its history.
 *
 * A draft or a reopened submission this person may change opens in the
 * renderer, autosaving on the server as they go. Anything else is read back
 * against the version it answered, with every submit, reopening and correction
 * listed beneath, each showing the answers as they were and what changed.
 */
export function SubmissionScreen({ submissionId }: { submissionId: string }) {
  const { t } = useTranslation();
  const { client, locale, paths } = useScreens();
  const queries = useQueryClient();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const [reopening, setReopening] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const detail = useQuery({
    queryKey: keys.submission(submissionId),
    queryFn: async () =>
      (await client.GET('/v1/submissions/{submissionId}', { params: { path: { submissionId } } }))
        .data!,
    // Someone is typing into this; a background refetch must not replace what they typed.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const compiled = useMemo(
    () =>
      detail.data === undefined ? undefined : compileDefinition(detail.data.version.definition),
    [detail.data],
  );

  const back = <BackLink to={paths.submissions} label={t('submissions.detail.back')} />;

  if (detail.isPending || detail.isError || !compiled?.ok) {
    return (
      <div className="flex flex-col gap-6 text-start">
        <nav aria-label={t('nav.back')}>{back}</nav>
        {detail.isPending ? (
          <Loading />
        ) : detail.isError ? (
          <Failure error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <Failure error={undefined} />
        )}
      </div>
    );
  }

  const { submission, version, events } = detail.data;
  const job = submission.workOrder;
  const refresh = (next: SubmissionDetail) => {
    queries.setQueryData(keys.submission(submissionId), next);
    void queries.invalidateQueries({ queryKey: ['submissions', 'list'] });
    void queries.invalidateQueries({ queryKey: keys.drafts, exact: true });
  };

  return (
    <div className="flex flex-col gap-6 text-start">
      <nav aria-label={t('nav.back')} className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {job === null || paths.workOrder === undefined ? null : (
          <BackLink
            to={paths.workOrder(job.id)}
            label={t('submissions.backToJob', { reference: job.referenceLabel })}
          />
        )}
        {back}
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{submission.formTitle}</h1>
          <p className="text-sm text-content-muted">
            {t('submissions.detail.version', { number: version.versionNumber ?? 0 })}
            {' · '}
            {t(`submissions.status.${submission.status}`)}
          </p>
          <p className="text-sm text-content-muted">
            {submission.submittedAt === null
              ? t('submissions.detail.draftBy', { name: submission.submittedBy.name })
              : t('submissions.detail.submittedBy', {
                  name: submission.submittedBy.name,
                  when: formatDateTime(submission.submittedAt, { locale }),
                })}
          </p>
        </div>
        {detail.data.can.reopen ? (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setReopening(true)}
          >
            {t('submissions.detail.reopen')}
          </button>
        ) : null}
      </header>

      {justSubmitted ? (
        <p role="status" className="rounded-md bg-success-subtle px-4 py-3 text-sm text-content">
          {t('submissions.detail.submitted')}
        </p>
      ) : null}

      {detail.data.can.edit ? (
        <Editor
          key={`${submission.id}:${submission.status}`}
          detail={detail.data}
          form={compiled.form}
          media={media}
          onSubmitted={(next) => {
            setJustSubmitted(true);
            refresh(next);
          }}
          onReload={() => void detail.refetch()}
        />
      ) : (
        <AnswerView
          form={compiled.form}
          answers={submission.answers}
          locale={locale}
          media={media}
        />
      )}

      {events.length === 0 ? null : <History events={events} form={compiled.form} media={media} />}

      {reopening ? (
        <ReopenDialog
          detail={detail.data}
          onClose={() => setReopening(false)}
          onReopened={(next) => {
            setReopening(false);
            setJustSubmitted(false);
            refresh(next);
          }}
        />
      ) : null}
    </div>
  );
}

type Save = 'saved' | 'pending' | 'saving' | 'failed' | 'conflict';

function Editor({
  detail,
  form,
  media,
  onSubmitted,
  onReload,
}: {
  detail: SubmissionDetail;
  form: Parameters<typeof FormFiller>[0]['form'];
  media: ReturnType<typeof apiMediaAdapter>;
  onSubmitted: (next: SubmissionDetail) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useScreens();
  const submissionId = detail.submission.id;
  const [status, setStatus] = useState<Save>('saved');
  const sync = useRef({
    revision: detail.submission.revision,
    latest: undefined as Answers | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    inFlight: undefined as Promise<void> | undefined,
    conflict: false,
  });

  // A failed save retries itself; through a ref, so the callback need not name itself.
  const retry = useRef<() => void>(() => undefined);

  const save = useCallback(async () => {
    const state = sync.current;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    while (state.inFlight !== undefined) {
      await state.inFlight;
    }
    const answers = state.latest;
    if (answers === undefined || state.conflict) {
      return;
    }
    state.latest = undefined;
    setStatus('saving');
    state.inFlight = (async () => {
      try {
        const saved = (
          await client.PUT('/v1/submissions/{submissionId}/answers', {
            params: { path: { submissionId } },
            body: { answers, expectedRevision: state.revision },
          })
        ).data!;
        state.revision = saved.revision;
        setStatus(state.latest === undefined ? 'saved' : 'pending');
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          state.conflict = true;
          setStatus('conflict');
        } else {
          state.latest ??= answers;
          setStatus('failed');
          state.timer = setTimeout(() => retry.current(), 5_000);
        }
      } finally {
        state.inFlight = undefined;
      }
    })();
    await state.inFlight;
  }, [client, submissionId]);

  useEffect(() => {
    retry.current = () => void save();
  }, [save]);

  useEffect(
    () => () => {
      if (sync.current.timer !== undefined) {
        clearTimeout(sync.current.timer);
      }
    },
    [],
  );

  const onAnswersChange = (answers: Record<string, unknown>) => {
    const state = sync.current;
    state.latest = answers;
    if (!state.conflict) {
      setStatus('pending');
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => void save(), 800);
    }
  };

  const onSubmit = async (
    answers: Record<string, unknown>,
    extra: { reason?: string },
  ): Promise<SubmitOutcome> => {
    await save();
    try {
      const next = (
        await client.POST('/v1/submissions/{submissionId}/submit', {
          params: { path: { submissionId } },
          body: {
            answers,
            expectedRevision: sync.current.revision,
            today: localToday(),
            ...(extra.reason === undefined ? {} : { reason: extra.reason }),
          },
        })
      ).data!;
      onSubmitted(next);
      return { ok: true };
    } catch (error) {
      const problems = problemsOf(error);
      return {
        ok: false,
        problems:
          problems.length > 0
            ? problems
            : [
                {
                  field: undefined,
                  message:
                    error instanceof ApiRequestError ? error.message : t('errors.unexpected'),
                },
              ],
      };
    }
  };

  const label = {
    saved: t('submissions.detail.saved'),
    pending: t('submissions.detail.unsaved'),
    saving: t('submissions.detail.saving'),
    failed: t('submissions.detail.saveFailed'),
    conflict: t('submissions.detail.unsaved'),
  }[status];

  return (
    <div className="flex flex-col gap-4">
      <p
        role="status"
        aria-live="polite"
        className={`text-xs ${status === 'failed' ? 'text-danger' : 'text-content-muted'}`}
      >
        {label}
      </p>
      {status === 'conflict' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md bg-danger-subtle px-4 py-3 text-sm text-content"
        >
          <span>{t('submissions.detail.conflict')}</span>
          <button type="button" className={buttonClass.secondary} onClick={onReload}>
            {t('submissions.detail.reload')}
          </button>
        </div>
      ) : null}
      <FormFiller
        form={form}
        initialAnswers={detail.submission.answers}
        locale={locale}
        media={media}
        today={localToday()}
        correction={detail.submission.status === 'reopened'}
        onAnswersChange={onAnswersChange}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function History({
  events,
  form,
  media,
}: {
  events: SubmissionDetail['events'];
  form: Parameters<typeof AnswerView>[0]['form'];
  media: ReturnType<typeof apiMediaAdapter>;
}) {
  const { t } = useTranslation();
  const { locale } = useScreens();
  const [open, setOpen] = useState<number | undefined>(undefined);

  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-3">
      <h2 id="history-heading" className="text-lg font-semibold text-content">
        {t('submissions.detail.history')}
      </h2>
      <ol className="flex flex-col gap-3 border-s-2 border-border-subtle ps-4">
        {events.map((event, index) => {
          const previous = events
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.answers !== null)?.answers;
          return (
            <li key={event.sequence} className="flex flex-col gap-1">
              <p className="text-sm font-medium text-content">
                {t(`submissions.detail.event.${event.kind}`, { name: event.actor.name })}
                <span className="ms-2 text-xs font-normal text-content-muted">
                  {formatDateTime(event.occurredAt, { locale })}
                </span>
              </p>
              {event.reason === null ? null : (
                <p className="text-sm text-content-muted">
                  {t('submissions.detail.reason', { reason: event.reason })}
                </p>
              )}
              {event.location === null ? null : (
                <SubmitLocationLine location={event.location} locale={locale} />
              )}
              {event.answers === null ? null : (
                <div className="flex flex-col gap-2">
                  <div>
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      aria-expanded={open === event.sequence}
                      onClick={() => setOpen(open === event.sequence ? undefined : event.sequence)}
                    >
                      {open === event.sequence
                        ? t('submissions.detail.hideAnswers')
                        : t('submissions.detail.showAnswers')}
                    </button>
                  </div>
                  {open === event.sequence ? (
                    <AnswerView
                      form={form}
                      answers={event.answers}
                      previous={event.kind === 'amended' ? (previous ?? undefined) : undefined}
                      locale={locale}
                      media={media}
                    />
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ReopenDialog({
  detail,
  onClose,
  onReopened,
}: {
  detail: SubmissionDetail;
  onClose: () => void;
  onReopened: (next: SubmissionDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useScreens();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const reopen = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onReopened(
        (
          await client.POST('/v1/submissions/{submissionId}/reopen', {
            params: { path: { submissionId: detail.submission.id } },
            body: { reason: reason.trim(), expectedRevision: detail.submission.revision },
          })
        ).data!,
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('submissions.detail.reopenTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={reason.trim() === '' || busy}
            aria-busy={busy}
            onClick={() => void reopen()}
          >
            {t('submissions.detail.reopenConfirm')}
          </button>
        </>
      }
    >
      <p>{t('submissions.detail.reopenBody')}</p>
      <label className="flex flex-col gap-1">
        <span className="font-medium">{t('submissions.detail.reopenReason')}</span>
        <textarea
          rows={3}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
      </label>
      {error === undefined ? null : <Failure error={error} />}
    </Dialog>
  );
}

/**
 * Where a phone was when it submitted (P13), or why it does not say. Evidence
 * about the visit, shown with the history entry it belongs to.
 */
function SubmitLocationLine({
  location,
  locale,
}: {
  location: NonNullable<SubmissionDetail['events'][number]['location']>;
  locale: string;
}) {
  const { t } = useTranslation();
  if (location.status !== 'captured') {
    return (
      <p className="text-sm text-content-muted">
        {t(`submissions.detail.location.${location.status}`)}
      </p>
    );
  }
  const when = formatDateTime(location.capturedAt, { locale });
  const map = `https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=18/${location.latitude}/${location.longitude}`;
  return (
    <p className="text-sm text-content-muted">
      {location.accuracyMeters === undefined
        ? t('submissions.detail.location.capturedNoAccuracy', {
            latitude: location.latitude,
            longitude: location.longitude,
            when,
          })
        : t('submissions.detail.location.captured', {
            latitude: location.latitude,
            longitude: location.longitude,
            meters: location.accuracyMeters,
            when,
          })}{' '}
      <a href={map} target="_blank" rel="noreferrer noopener" className="text-accent underline">
        {t('submissions.detail.location.openMap')}
      </a>
    </p>
  );
}
