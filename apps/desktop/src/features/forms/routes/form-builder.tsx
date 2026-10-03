import { ApiRequestError } from '@integr8/api-client';
import { allIds, compileDefinition, type FormDefinition } from '@integr8/form-engine';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, ErrorState, LoadingState, Shell } from '~/components/ui';
import { canManageForms, type FormDetail, formKeys, useForm, useMe, useVersions } from '../api';
import { BuilderWorkspace, nameOf } from '../components/canvas';
import { ChangesPanel, PublishDialog } from '../components/changes-panel';
import { ConfigPanel } from '../components/config-panel';
import { Dialog } from '../components/dialog';
import { HistoryPanel, SettingsPanel } from '../components/history-settings';
import { PreviewPanel } from '../components/preview-panel';
import { editorReducer, initialEditor } from '../model/editor';
import { issueElement, issueText } from '../model/issues';
import {
  clearLocalCopy,
  type Recovery,
  readLocalCopy,
  recoveryFor,
  recoveryKey,
  sameDefinition,
} from '../model/recovery';
import { useDraftSync } from '../use-draft-sync';

/**
 * The form builder.
 *
 * Loads the draft if there is one, or the live version if not — editing a
 * published form starts a new draft on the first change. People who cannot
 * build forms get the same screen with every control disabled, so "what does
 * this form ask?" has one answer everywhere.
 */
export function FormBuilderRoute() {
  const { formId = '' } = useParams();
  const detail = useForm(formId);
  const me = useMe();

  if (detail.isPending || me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (detail.isError || me.isError) {
    const error = detail.error ?? me.error;
    return (
      <Shell>
        <ErrorState
          requestId={error instanceof ApiRequestError ? error.requestId : undefined}
          onRetry={() => void detail.refetch()}
        />
      </Shell>
    );
  }

  const source = detail.data.draft ?? detail.data.live;
  if (source === null) {
    return (
      <Shell>
        <ErrorState />
      </Shell>
    );
  }

  return (
    <Builder
      key={`${formId}:${source.id}:${String(detail.data.draft?.revision ?? 0)}`}
      detail={detail.data}
      tenantId={me.data.tenantId}
      manage={canManageForms(me.data)}
    />
  );
}

type Tab = 'build' | 'preview' | 'changes' | 'history' | 'settings';

function Builder({
  detail,
  tenantId,
  manage,
}: {
  detail: FormDetail;
  tenantId: string;
  manage: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const queries = useQueryClient();
  const formId = detail.form.id;
  const source = (detail.draft ?? detail.live)!;
  const key = recoveryKey(tenantId, formId);

  const [editor, dispatch] = useReducer(
    editorReducer,
    source.definition as unknown as FormDefinition,
    initialEditor,
  );
  const [tab, setTab] = useState<Tab>('build');
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [live, setLive] = useState(detail.live);

  const sync = useDraftSync({
    formId,
    recoveryKey: manage ? key : undefined,
    definition: editor.definition,
    baseline: {
      revision: detail.draft?.revision ?? null,
      definition: source.definition,
    },
    enabled: manage,
  });

  const [recovery, setRecovery] = useState<Recovery>(() => {
    if (!manage) {
      return { kind: 'none' };
    }
    const copy = readLocalCopy(key);
    if (
      copy !== undefined &&
      detail.draft === null &&
      sameDefinition(copy.definition, detail.live?.definition)
    ) {
      return { kind: 'none' };
    }
    return recoveryFor(
      copy,
      detail.draft === null
        ? undefined
        : { revision: detail.draft.revision, definition: detail.draft.definition },
    );
  });

  const compiled = useMemo(() => compileDefinition(editor.definition), [editor.definition]);
  // Every id a published version has used: the live version's, plus everything an earlier
  // publish removed (each version's change summary records it). Submissions are stored under
  // these keys, so a new question must never be given one of them.
  const versions = useVersions(formId, manage);
  const publishedIds = useMemo(() => {
    const ids = new Set(live === null ? [] : allIds(live.definition as unknown as FormDefinition));
    for (const version of versions.data ?? []) {
      const changes = (version.changes as { changes?: { kind: string; element: string }[] } | null)
        ?.changes;
      for (const change of changes ?? []) {
        if (change.kind === 'removed') {
          ids.add(change.element);
        }
      }
    }
    return ids;
  }, [live, versions.data]);

  // Keyboard undo and redo, as everywhere else on the desktop.
  useEffect(() => {
    if (!manage) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('input, textarea, select, [contenteditable="true"]') !== null &&
        target !== null
      ) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manage]);

  const show = (elementId: string) => {
    setTab('build');
    dispatch({ type: 'select', id: elementId });
  };

  const tabs: Tab[] = manage
    ? ['build', 'preview', 'changes', 'history', 'settings']
    : ['build', 'preview', 'history'];
  const problems = compiled.ok ? 0 : compiled.issues.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border-subtle bg-surface px-6 py-3 text-start">
        <Link to="/forms" className="text-sm text-content-muted hover:underline">
          {t('forms.builder.back')}
        </Link>
        <h1 className="min-w-0 truncate text-lg font-semibold text-content">{detail.form.title}</h1>
        {manage ? <SaveStatus status={sync.status} hasDraft={sync.revision !== null} /> : null}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {manage ? (
            <>
              <button
                type="button"
                onClick={() => setTab('changes')}
                className={[
                  'rounded-full px-3 py-1 text-xs',
                  problems === 0
                    ? 'bg-success-subtle text-content'
                    : 'bg-danger-subtle text-content',
                ].join(' ')}
              >
                {problems === 0
                  ? t('forms.builder.noProblems')
                  : t('forms.builder.problems', { count: problems })}
              </button>
              <Button
                variant="ghost"
                disabled={editor.past.length === 0}
                onClick={() => dispatch({ type: 'undo' })}
              >
                {t('forms.builder.undo')}
              </Button>
              <Button
                variant="ghost"
                disabled={editor.future.length === 0}
                onClick={() => dispatch({ type: 'redo' })}
              >
                {t('forms.builder.redo')}
              </Button>
              <Button disabled={sync.status === 'conflict'} onClick={() => setPublishing(true)}>
                {t('forms.builder.publish')}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex gap-1 border-b border-border-subtle bg-surface px-6" role="tablist">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={[
              'border-b-2 px-3 py-2 text-sm',
              tab === name
                ? 'border-accent font-medium text-content'
                : 'border-transparent text-content-muted hover:text-content',
            ].join(' ')}
          >
            {t(`forms.builder.tabs.${name}`)}
          </button>
        ))}
      </div>

      {!manage ? (
        <p className="bg-surface-muted px-6 py-2 text-start text-sm text-content-muted">
          {t('forms.builder.readOnly')}
        </p>
      ) : null}

      {sync.status === 'conflict' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 bg-danger-subtle px-6 py-2 text-start text-sm text-content"
        >
          <span>{t('forms.builder.save.conflict')}</span>
          <Button
            variant="secondary"
            onClick={() => {
              clearLocalCopy(key);
              void queries.invalidateQueries({ queryKey: formKeys.detail(formId) });
            }}
          >
            {t('forms.builder.save.loadTheirs')}
          </Button>
        </div>
      ) : null}

      {notice === undefined ? null : (
        <div
          role="status"
          className="flex items-center gap-3 bg-success-subtle px-6 py-2 text-start text-sm text-content"
        >
          <span>{notice}</span>
          <Button variant="ghost" onClick={() => setNotice(undefined)}>
            {t('common.close')}
          </Button>
        </div>
      )}

      {editor.refused === undefined ? null : (
        <p role="alert" className="bg-warning-subtle px-6 py-2 text-start text-sm text-content">
          {t(`forms.builder.refused.${editor.refused.error}`)}
        </p>
      )}

      {tab === 'build' ? (
        <BuilderWorkspace
          publishedIds={publishedIds}
          definition={editor.definition}
          selected={editor.selected}
          locale={locale}
          readOnly={!manage}
          dispatch={dispatch}
          panel={
            <ConfigPanel
              definition={editor.definition}
              selected={editor.selected}
              selection={editor.selection}
              publishedIds={publishedIds}
              locale={locale}
              dispatch={dispatch}
              readOnly={!manage}
            />
          }
        />
      ) : null}

      {tab === 'preview' ? (
        compiled.ok ? (
          <PreviewPanel
            form={compiled.form}
            formId={formId}
            locale={locale}
            canTest={manage && (sync.revision !== null || sync.status !== 'saved')}
            flush={sync.flush}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-6 text-start">
            <p className="font-medium text-content">{t('forms.preview.broken')}</p>
            <ul className="flex flex-col gap-2">
              {compiled.issues.map((issue) => (
                <li
                  key={`${issue.path}-${issue.code}`}
                  className="flex items-start justify-between gap-3 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm"
                >
                  <span className="flex flex-col gap-0.5">
                    {issueElement(editor.definition, issue) === undefined ? null : (
                      <span className="font-medium">
                        {t('forms.changes.in', {
                          name: nameOf(
                            editor.definition,
                            issueElement(editor.definition, issue)!,
                            locale,
                            t,
                          ),
                        })}
                      </span>
                    )}
                    <span>
                      {issueText(issue, (id) => nameOf(editor.definition, id, locale, t), t)}
                    </span>
                  </span>
                  {issueElement(editor.definition, issue) === undefined ? null : (
                    <Button
                      variant="ghost"
                      onClick={() => show(issueElement(editor.definition, issue)!)}
                    >
                      {t('forms.changes.show')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {tab === 'changes' ? (
        <ChangesPanel
          formId={formId}
          definition={editor.definition}
          locale={locale}
          hasLive={live !== null}
          flush={sync.flush}
          onShow={show}
        />
      ) : null}

      {tab === 'history' ? <HistoryPanel formId={formId} locale={locale} /> : null}
      {tab === 'settings' ? <SettingsPanel detail={detail} /> : null}

      {manage && publishing ? (
        <PublishDialog
          formId={formId}
          definition={editor.definition}
          locale={locale}
          nextVersion={(live?.versionNumber ?? 0) + 1}
          hasLive={live !== null}
          flush={sync.flush}
          onClose={() => setPublishing(false)}
          onShow={show}
          onPublished={(version) => {
            setPublishing(false);
            setLive({
              ...version,
              definition: editor.definition as unknown as Record<string, unknown>,
            });
            // The draft became the version; the next edit starts a new draft.
            sync.reset({ revision: null, definition: editor.definition });
            setNotice(t('forms.publish.published', { number: version.versionNumber ?? 0 }));
          }}
        />
      ) : null}

      <Dialog
        open={recovery.kind !== 'none'}
        title={t('forms.builder.recovery.title')}
        onClose={() => setRecovery({ kind: 'none' })}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                clearLocalCopy(key);
                setRecovery({ kind: 'none' });
              }}
            >
              {t('forms.builder.recovery.discard')}
            </Button>
            <Button
              variant={recovery.kind === 'stale' ? 'danger' : 'primary'}
              onClick={() => {
                if (recovery.kind !== 'none') {
                  const restored = recovery.copy.definition as unknown as FormDefinition;
                  dispatch({ type: 'edit', apply: () => restored });
                }
                setRecovery({ kind: 'none' });
              }}
            >
              {t('forms.builder.recovery.restore')}
            </Button>
          </>
        }
      >
        {recovery.kind === 'none' ? null : (
          <p>
            {t(
              recovery.kind === 'stale'
                ? 'forms.builder.recovery.staleBody'
                : 'forms.builder.recovery.restoreBody',
              {
                when: formatDateTime(recovery.copy.savedAt, { locale }),
              },
            )}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function SaveStatus({
  status,
  hasDraft,
}: {
  status: ReturnType<typeof useDraftSync>['status'];
  hasDraft: boolean;
}) {
  const { t } = useTranslation();
  const text = {
    saved: hasDraft ? t('forms.builder.save.saved') : t('forms.builder.save.matchesLive'),
    pending: t('forms.builder.save.unsaved'),
    saving: t('forms.builder.save.saving'),
    failed: t('forms.builder.save.failed'),
    conflict: t('forms.builder.save.unsaved'),
  }[status];
  return (
    <span
      role="status"
      aria-live="polite"
      className={`text-xs ${status === 'failed' ? 'text-danger' : 'text-content-muted'}`}
    >
      {text}
    </span>
  );
}
