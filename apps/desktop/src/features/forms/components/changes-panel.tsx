import { ApiRequestError } from '@integr8/api-client';
import type { FormDefinition } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { checkDraft, type DraftCheck, formKeys, publishDraft, type VersionSummary } from '../api';
import { breakingText, issueElement, issueText } from '../model/issues';
import { nameOf } from './canvas';
import { Dialog } from './dialog';

/**
 * What publishing would do, before anybody does it.
 *
 * Both this tab and the publish dialog ask the server, not the browser: the
 * server compiles the saved draft and compares it with the live version, so
 * what is shown here is exactly what `publish` will decide.
 */

type Diff = DraftCheck['diff'];

/**
 * Saves anything pending, then asks the server what publishing would decide.
 *
 * A query rather than an effect: it runs when the tab or dialog mounts, is never
 * cached (a check is only true of the draft it saw), and refetching is "Check again".
 */
function useCheck(formId: string, flush: () => Promise<number | null>) {
  const query = useQuery({
    queryKey: formKeys.check(formId),
    queryFn: async (): Promise<DraftCheck | null> => {
      const revision = await flush();
      if (revision === null) {
        return null;
      }
      try {
        return await checkDraft(formId);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const state:
    | { kind: 'checking' }
    | { kind: 'done'; check: DraftCheck }
    | { kind: 'no_draft' }
    | { kind: 'failed'; requestId: string | undefined } = query.isFetching
    ? { kind: 'checking' }
    : query.isError
      ? {
          kind: 'failed',
          requestId: query.error instanceof ApiRequestError ? query.error.requestId : undefined,
        }
      : query.data === null || query.data === undefined
        ? { kind: 'no_draft' }
        : { kind: 'done', check: query.data };

  return { state, run: () => query.refetch() };
}

export function ChangesPanel({
  formId,
  definition,
  locale,
  hasLive,
  flush,
  onShow,
}: {
  formId: string;
  definition: FormDefinition;
  locale: string;
  hasLive: boolean;
  flush: () => Promise<number | null>;
  onShow: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  const { state, run } = useCheck(formId, flush);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6 text-start">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold text-content">{t('forms.changes.title')}</h2>
        <Button variant="secondary" onClick={() => void run()} busy={state.kind === 'checking'}>
          {t('forms.changes.recheck')}
        </Button>
      </div>

      {state.kind === 'checking' ? <LoadingState /> : null}
      {state.kind === 'failed' ? (
        <ErrorState requestId={state.requestId} onRetry={() => void run()} />
      ) : null}
      {state.kind === 'no_draft' ? (
        <p className="text-sm text-content-muted">{t('forms.changes.noDraft')}</p>
      ) : null}
      {state.kind === 'done' ? (
        <CheckReport
          check={state.check}
          definition={definition}
          locale={locale}
          hasLive={hasLive}
          onShow={onShow}
        />
      ) : null}
    </div>
  );
}

function CheckReport({
  check,
  definition,
  locale,
  hasLive,
  onShow,
}: {
  check: DraftCheck;
  definition: FormDefinition;
  locale: string;
  hasLive: boolean;
  onShow?: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-content">{t('forms.changes.problemsTitle')}</h3>
        {check.issues.length === 0 ? (
          <p className="text-sm text-content-muted">{t('forms.changes.noProblems')}</p>
        ) : (
          <IssueList
            issues={check.issues}
            definition={definition}
            locale={locale}
            onShow={onShow}
          />
        )}
      </section>
      {check.valid ? (
        <>
          <BreakingList diff={check.diff} definition={definition} locale={locale} />
          <ChangeList diff={check.diff} definition={definition} locale={locale} hasLive={hasLive} />
        </>
      ) : null}
    </>
  );
}

export function IssueList({
  issues,
  definition,
  locale,
  onShow,
}: {
  issues: DraftCheck['issues'];
  definition: FormDefinition;
  locale: string;
  onShow?: ((elementId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue) => (
        <li
          key={`${issue.path}-${issue.code}`}
          className="flex items-start justify-between gap-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-content"
        >
          <span className="flex flex-col gap-0.5">
            {issueElement(definition, issue) === undefined ? null : (
              <span className="font-medium">
                {t('forms.changes.in', {
                  name: nameOf(definition, issueElement(definition, issue)!, locale, t),
                })}
              </span>
            )}
            <span>{issueText(issue, (id) => nameOf(definition, id, locale, t), t)}</span>
          </span>
          {onShow === undefined || issueElement(definition, issue) === undefined ? null : (
            <Button variant="ghost" onClick={() => onShow(issueElement(definition, issue)!)}>
              {t('forms.changes.show')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function BreakingList({
  diff,
  definition,
  locale,
}: {
  diff: Diff;
  definition: FormDefinition;
  locale: string;
}) {
  const { t } = useTranslation();
  if (diff.breaking.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-content">{t('forms.changes.breakingTitle')}</h3>
      <ul className="flex flex-col gap-2">
        {diff.breaking.map((entry) => (
          <li
            key={`${entry.field}-${entry.reason}`}
            className="flex flex-col gap-1 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-content"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{nameOf(definition, entry.field, locale, t)}</span>
              <span className="text-xs text-content-muted">
                {t(`forms.changes.affects.${entry.affects}`)}
              </span>
            </div>
            <span>{breakingText(entry, t)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangeList({
  diff,
  definition,
  locale,
  hasLive,
}: {
  diff: Diff;
  definition: FormDefinition;
  locale: string;
  hasLive: boolean;
}) {
  const { t } = useTranslation();
  if (!hasLive) {
    return <p className="text-sm text-content-muted">{t('forms.changes.firstVersion')}</p>;
  }
  if (diff.changes.length === 0 && !diff.titleChanged) {
    return <p className="text-sm text-content-muted">{t('forms.changes.none')}</p>;
  }
  return (
    <section className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface">
        {diff.titleChanged ? (
          <li className="px-3 py-2 text-sm text-content">{t('forms.changes.titleChanged')}</li>
        ) : null}
        {diff.changes.map((change) => (
          <li
            key={`${change.kind}-${change.element}`}
            className="flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm text-content"
          >
            <span className="w-20 shrink-0 font-medium">
              {t(`forms.changes.kind.${change.kind}`)}
            </span>
            <span className="text-xs text-content-muted">
              {t(`forms.changes.element.${change.elementKind}`)}
            </span>
            <span>
              {change.kind === 'removed'
                ? change.element
                : nameOf(definition, change.element, locale, t)}
            </span>
            {change.properties.length === 0 ? null : (
              <span className="text-xs text-content-muted">
                {t('forms.changes.properties', { list: change.properties.join(', ') })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Publishing: check, explain, confirm. Mounted only while open, so every opening
 * starts from a fresh check with nothing ticked.
 *
 *
 * The dialog cannot offer "Publish" until the server has said the draft
 * compiles, and cannot publish breaking changes until the person has ticked
 * that they understand them. The server enforces both again.
 */
export function PublishDialog({
  formId,
  definition,
  locale,
  nextVersion,
  hasLive,
  flush,
  onClose,
  onPublished,
  onShow,
}: {
  formId: string;
  definition: FormDefinition;
  locale: string;
  nextVersion: number;
  hasLive: boolean;
  flush: () => Promise<number | null>;
  onClose: () => void;
  onPublished: (version: VersionSummary) => void;
  onShow: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const { state, run } = useCheck(formId, flush);
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const check = state.kind === 'done' ? state.check : undefined;
  const breaking = (check?.diff.breaking.length ?? 0) > 0;
  const canPublish = check?.valid === true && (!breaking || acknowledged) && !publishing;

  const publish = async () => {
    if (check === undefined) {
      return;
    }
    setPublishing(true);
    setProblem(undefined);
    try {
      const version = await publishDraft(formId, {
        expectedRevision: check.revision,
        ...(note.trim() === '' ? {} : { changeNote: note.trim() }),
        acknowledgeBreakingChanges: acknowledged,
      });
      setNote('');
      await Promise.all([
        queries.invalidateQueries({ queryKey: formKeys.list, exact: true }),
        queries.invalidateQueries({ queryKey: formKeys.versions(formId) }),
      ]);
      onPublished(version);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        setProblem(t('forms.publish.draftChanged'));
        void run();
      } else {
        setProblem(
          error instanceof ApiRequestError
            ? t('errors.body', { requestId: error.requestId })
            : t('errors.unexpected'),
        );
      }
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog
      open
      wide
      title={t('forms.publish.title', { number: nextVersion })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canPublish} busy={publishing} onClick={() => void publish()}>
            {t('forms.publish.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('forms.publish.body')}</p>
      {problem === undefined ? null : (
        <p role="alert" className="rounded-md border border-danger bg-danger-subtle px-3 py-2">
          {problem}
        </p>
      )}
      {state.kind === 'checking' ? <LoadingState label={t('forms.publish.checking')} /> : null}
      {state.kind === 'failed' ? (
        <ErrorState requestId={state.requestId} onRetry={() => void run()} />
      ) : null}
      {state.kind === 'no_draft' ? <p>{t('forms.publish.nothing')}</p> : null}
      {check !== undefined && !check.valid ? (
        <>
          <p className="font-medium">{t('forms.publish.blocked')}</p>
          <IssueList
            issues={check.issues}
            definition={definition}
            locale={locale}
            onShow={(id) => {
              onClose();
              onShow(id);
            }}
          />
        </>
      ) : null}
      {check?.valid === true ? (
        <>
          <BreakingList diff={check.diff} definition={definition} locale={locale} />
          {breaking ? (
            <label className="flex items-start gap-2 font-medium">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1"
              />
              {t('forms.publish.acknowledge')}
            </label>
          ) : null}
          <ChangeList diff={check.diff} definition={definition} locale={locale} hasLive={hasLive} />
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('forms.publish.note')}</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={note}
              placeholder={t('forms.publish.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm"
            />
          </label>
        </>
      ) : null}
    </Dialog>
  );
}
