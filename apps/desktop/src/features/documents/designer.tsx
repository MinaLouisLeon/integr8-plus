import { ApiRequestError } from '@integr8/api-client';
import {
  checkDesignAgainstForm,
  type DesignIssue,
  emptyDesign,
  parseDesign,
  type TemplateDesign,
} from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { formatDateTime, type TFunction, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { session } from '~/lib/session';
import { Dialog } from '../forms/components/dialog';
import {
  clearLocalCopy,
  type Recovery,
  recoveryFor,
  sameDefinition,
  writeLocalCopy,
} from '../forms/model/recovery';
import { BlockTree, type ChangeKind } from './block-editor';
import { CheckInput } from './designer-inputs';
import { BandsEditor, FieldsEditor, PageEditor, StyleEditor } from './designer-page';
import { Preview } from './designer-preview';
import {
  CLIPBOARD_EVENT,
  clipboardKey,
  type Draft,
  historyReducer,
  initialHistory,
  readClipboard,
  readLocalCopy,
  templateRecoveryKey,
  writeClipboard,
} from './designer-state';
import { blocksIn, duplicateBlock, insertBlocks, locateBlock } from './designer-tree';
import { useLeaveGuard } from './leave-guard';
import { TemplateCopyActions } from './template-copy';

/**
 * The PDF template designer (docs/documents ADR-0001 D1–D3), a tab of the
 * form builder for Integr8 staff in a company's seat.
 *
 * A form's templates are listed on the left; the one open is edited in parts —
 * the page, the header and footer, the style, the document fields, the
 * content — with a preview beside it: the live page, drawn by the same
 * renderer the server prints with, and the real PDF on request.
 *
 * Since 1.3.0 (decisions 8 and 13): undo and redo, blocks dragged, duplicated
 * and copied between the form's templates, unsaved work kept on this device
 * and offered back, a warning before leaving it, and templates the form has
 * moved on from marked "needs attention" with the blocks to fix.
 */

const client = () => session().client;
const templateKeys = {
  list: (formId: string) => ['documents', 'templates', formId] as const,
};

type Template = NonNullable<Awaited<ReturnType<typeof listTemplates>>>['items'][number];

async function listTemplates(formId: string) {
  return (
    await client().GET('/v1/document-templates', {
      params: { query: { formId, includeArchived: 'true' } },
    })
  ).data!;
}

/** A design as the designer edits it: version 2, the defaults filled in. */
function designOf(stored: unknown): TemplateDesign {
  const parsed = parseDesign(stored);
  return parsed.ok ? parsed.design : emptyDesign();
}

/** What is wrong with each block or document field, in words, keyed by block id or field key. */
function attentionOf(issues: readonly DesignIssue[], t: TFunction): Map<string, string> {
  const out = new Map<string, string>();
  for (const issue of issues) {
    const [scope, id] = issue.path.split('.');
    if ((scope === 'blocks' || scope === 'fields') && id !== undefined && !out.has(id)) {
      out.set(
        id,
        t(`documents.pdfBuilder.attention.codes.${issue.code}`, { defaultValue: issue.message }),
      );
    }
  }
  return out;
}

export interface DesignerCompany {
  tenantId: string;
  name: string;
  /** The company's accent colour, `#rrggbb`. */
  brandColour: string | null;
  logoMediaId: string | null;
}

export function DocumentDesigner({
  formId,
  formTitle,
  form,
  locale,
  enabled,
  company,
  active = true,
}: {
  formId: string;
  formTitle: string;
  /** The form as last published, or null when it never was. */
  form: CompiledForm | null;
  locale: string;
  /** Whether the company has documents switched on. */
  enabled: boolean;
  company: DesignerCompany;
  /** False while the form builder shows another tab: keys are left alone. */
  active?: boolean;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const guard = useLeaveGuard(dirty);

  const templates = useQuery({
    queryKey: templateKeys.list(formId),
    queryFn: () => listTemplates(formId),
    enabled: enabled && form !== null,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await client().POST('/v1/document-templates', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { formId, name: name.trim() },
        })
      ).data!,
    onSuccess: (created) => {
      setName('');
      setDirty(false);
      setSelected(created.id);
      void queries.invalidateQueries({ queryKey: templateKeys.list(formId) });
    },
  });

  // Each template checked against the form as published, for the list's marks.
  const needsAttention = useMemo(() => {
    const out = new Set<string>();
    if (form === null) {
      return out;
    }
    for (const item of templates.data?.items ?? []) {
      const parsed = parseDesign(item.design);
      if (!parsed.ok || checkDesignAgainstForm(parsed.design, form).length > 0) {
        out.add(item.id);
      }
    }
    return out;
  }, [templates.data, form]);

  if (!enabled) {
    return <EmptyState body={t('documents.designer.moduleOff')} />;
  }
  if (form === null) {
    return <EmptyState body={t('documents.designer.notPublished')} />;
  }
  if (templates.isPending) {
    return <LoadingState />;
  }
  if (templates.isError) {
    return (
      <ErrorState
        requestId={
          templates.error instanceof ApiRequestError ? templates.error.requestId : undefined
        }
        onRetry={() => void templates.refetch()}
      />
    );
  }

  const items = templates.data.items.filter((item) => showArchived || !item.archived);
  const open = templates.data.items.find((item) => item.id === selected) ?? items[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4 text-start lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-60">
        <p className="text-sm text-content-muted">{t('documents.designer.intro')}</p>
        <h2 className="text-sm font-semibold text-content">{t('documents.designer.templates')}</h2>
        {items.length === 0 ? (
          <p className="text-sm text-content-muted">{t('documents.designer.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === open?.id ? 'true' : undefined}
                  onClick={() => {
                    if (item.id !== open?.id) {
                      guard.confirm(() => {
                        setDirty(false);
                        setSelected(item.id);
                      });
                    }
                  }}
                  className={[
                    'flex w-full flex-wrap items-center gap-x-2 rounded-md px-3 py-2 text-start text-sm',
                    item.id === open?.id
                      ? 'bg-accent-subtle font-medium text-content'
                      : 'text-content hover:bg-surface-muted',
                  ].join(' ')}
                >
                  <span dir="auto">{item.name}</span>
                  {item.archived ? (
                    <span className="text-xs text-content-muted">
                      {t('documents.designer.archived')}
                    </span>
                  ) : null}
                  {needsAttention.has(item.id) ? (
                    <span className="rounded-full bg-danger-subtle px-2 text-xs text-content">
                      {t('documents.pdfBuilder.attention.badge')}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <CheckInput
          label={t('documents.designer.showArchived')}
          checked={showArchived}
          onChange={setShowArchived}
        />
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') {
              guard.confirm(() => create.mutate());
            }
          }}
        >
          <Field
            label={t('documents.designer.newName')}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" busy={create.isPending} disabled={name.trim() === ''}>
            {t('documents.designer.create')}
          </Button>
          {create.isError ? <ServerProblems error={create.error} /> : null}
        </form>
      </aside>

      {open === undefined ? null : (
        <TemplateEditor
          key={open.id}
          template={open}
          form={form}
          formId={formId}
          formTitle={formTitle}
          locale={locale}
          company={company}
          active={active}
          onDirtyChange={setDirty}
        />
      )}
      {guard.dialog}
    </div>
  );
}

function TemplateEditor({
  template,
  form,
  formId,
  formTitle,
  locale,
  company,
  active,
  onDirtyChange,
}: {
  template: Template;
  form: CompiledForm;
  formId: string;
  formTitle: string;
  locale: string;
  company: DesignerCompany;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const initial = useMemo<Draft>(
    () => ({ design: designOf(template.design), name: template.name }),
    [template.design, template.name],
  );
  const [history, dispatch] = useReducer(historyReducer, initial, initialHistory);
  const { design, name } = history.present;
  const [saved, setSaved] = useState<Draft>(initial);
  const [revision, setRevision] = useState(template.revision);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = !sameDefinition(history.present, saved);
  const recoveryKey = templateRecoveryKey(company.tenantId, template.id);
  const clipboard = clipboardKey(company.tenantId, formId);
  const [clipboardBlocks, setClipboardBlocks] = useState(() => readClipboard(clipboard, formId));
  const [notice, setNotice] = useState<string | null>(null);

  const [recovery, setRecovery] = useState<Recovery>(() =>
    recoveryFor(readLocalCopy(recoveryKey), {
      revision: template.revision,
      definition: initial as unknown as Record<string, unknown>,
    }),
  );

  const change = useCallback((next: Draft, kind: ChangeKind) => {
    dispatch({ type: 'edit', draft: next, kind, at: Date.now() });
    setJustSaved(false);
  }, []);
  const setDesign = (next: TemplateDesign, kind: ChangeKind = 'typing') =>
    change({ design: next, name }, kind);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Every unsaved change is kept on this device until it is saved.
  useEffect(() => {
    if (dirty) {
      writeLocalCopy(recoveryKey, {
        baseRevision: revision,
        definition: history.present as unknown as Record<string, unknown>,
        savedAt: new Date().toISOString(),
      });
    } else if (recovery.kind === 'none') {
      clearLocalCopy(recoveryKey);
    }
  }, [dirty, history.present, recoveryKey, revision, recovery.kind]);

  // Undo and redo from the keyboard, outside the text boxes (they have their own).
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]') != null) {
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // Blocks copied in another of the form's templates become pasteable here.
  useEffect(() => {
    const refresh = () => setClipboardBlocks(readClipboard(clipboard, formId));
    window.addEventListener(CLIPBOARD_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CLIPBOARD_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [clipboard, formId]);

  const issues = useMemo(() => checkDesignAgainstForm(design, form), [design, form]);
  const attention = useMemo(() => attentionOf(issues, t), [issues, t]);

  const save = useMutation({
    mutationFn: async (draft: Draft) =>
      (
        await client().PATCH('/v1/document-templates/{templateId}', {
          params: { path: { templateId: template.id } },
          body: {
            revision,
            name: draft.name.trim(),
            design: draft.design,
          },
        })
      ).data!,
    onSuccess: (result, draft) => {
      setRevision(result.revision);
      setSaved(draft);
      setJustSaved(true);
      clearLocalCopy(recoveryKey);
      void queries.invalidateQueries({ queryKey: templateKeys.list(formId) });
    },
  });
  const archive = useMutation({
    mutationFn: async (archived: boolean) =>
      (
        await client().POST('/v1/document-templates/{templateId}/archive', {
          params: { path: { templateId: template.id } },
          body: { archived },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: templateKeys.list(formId) }),
  });
  const changedElsewhere =
    save.error instanceof ApiRequestError && save.error.code === 'document_template_changed';

  const copyBlock = (blockId: string) => {
    const place = locateBlock(design.blocks, blockId);
    const block =
      place === null ? undefined : blocksIn(design.blocks, place.container)[place.index];
    if (block !== undefined) {
      writeClipboard(clipboard, formId, [block]);
      setClipboardBlocks([block]);
      setNotice(t('documents.pdfBuilder.blocks.copied'));
    }
  };
  const duplicate = (blockId: string) => {
    const next = duplicateBlock(design, blockId);
    if (next !== null) {
      setDesign(next, 'step');
    }
  };
  const paste = () => {
    if (clipboardBlocks.length > 0) {
      setDesign(insertBlocks(design, clipboardBlocks), 'step');
      setNotice(t('documents.pdfBuilder.blocks.pasted', { count: clipboardBlocks.length }));
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 xl:flex-row">
      <div className="flex w-full min-w-0 flex-col gap-4 xl:max-w-xl">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Field
              label={t('documents.designer.name')}
              value={name}
              maxLength={120}
              onChange={(event) => change({ design, name: event.target.value }, 'typing')}
            />
          </div>
          <Button
            busy={save.isPending}
            disabled={!dirty || name.trim() === ''}
            onClick={() => save.mutate(history.present)}
          >
            {save.isPending ? t('documents.designer.saving') : t('documents.designer.save')}
          </Button>
          <Button
            variant="ghost"
            busy={archive.isPending}
            onClick={() => archive.mutate(!template.archived)}
          >
            {template.archived ? t('documents.designer.restore') : t('documents.designer.archive')}
          </Button>
          <TemplateCopyActions
            templateId={template.id}
            templateName={template.name}
            design={template.design}
            formId={formId}
            form={form}
            dirty={dirty}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            disabled={history.past.length === 0}
            aria-keyshortcuts="Control+Z"
            onClick={() => dispatch({ type: 'undo' })}
          >
            {t('documents.pdfBuilder.undo')}
          </Button>
          <Button
            variant="ghost"
            disabled={history.future.length === 0}
            aria-keyshortcuts="Control+Y"
            onClick={() => dispatch({ type: 'redo' })}
          >
            {t('documents.pdfBuilder.redo')}
          </Button>
          <Button variant="ghost" disabled={clipboardBlocks.length === 0} onClick={paste}>
            {clipboardBlocks.length === 0
              ? t('documents.pdfBuilder.blocks.pasteNothing')
              : t('documents.pdfBuilder.blocks.paste', { count: clipboardBlocks.length })}
          </Button>
          <p role="status" className="ms-auto text-xs text-content-muted">
            {notice ??
              (dirty
                ? t('documents.designer.unsaved')
                : justSaved
                  ? t('documents.designer.saved')
                  : '')}
          </p>
        </div>
        {changedElsewhere ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md bg-warning-subtle p-3 text-sm"
          >
            {t('documents.designer.changedElsewhere')}
            <Button
              variant="secondary"
              onClick={() =>
                void queries.invalidateQueries({ queryKey: templateKeys.list(formId) })
              }
            >
              {t('documents.designer.reload')}
            </Button>
          </div>
        ) : save.isError ? (
          <ServerProblems error={save.error} />
        ) : null}
        {issues.length > 0 ? (
          <div
            role="alert"
            className="rounded-md border border-danger bg-danger-subtle p-3 text-sm"
          >
            <p className="font-medium text-content">{t('documents.pdfBuilder.attention.title')}</p>
            <p className="text-content">{t('documents.pdfBuilder.attention.body')}</p>
            <ul className="mt-1 list-disc ps-5 text-content">
              {[...attention.entries()].map(([id, text]) => (
                <li key={id}>
                  <code dir="ltr" className="text-xs">
                    {id}
                  </code>{' '}
                  {text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Section title={t('documents.designer.section.page')}>
          <PageEditor design={design} onChange={setDesign} />
        </Section>
        <Section title={t('documents.pdfBuilder.bands.title')}>
          <BandsEditor design={design} onChange={setDesign} />
        </Section>
        <Section title={t('documents.pdfBuilder.style.title')}>
          <StyleEditor
            design={design}
            onChange={setDesign}
            companyBrandColour={company.brandColour}
          />
        </Section>
        <Section title={t('documents.designer.section.fields')}>
          <FieldsEditor
            design={design}
            form={form}
            locale={locale}
            attention={attention}
            onChange={setDesign}
          />
        </Section>
        <Section title={t('documents.designer.section.blocks')}>
          <BlockTree
            blocks={design.blocks}
            context={{
              design,
              form,
              locale,
              attention,
              onDuplicate: duplicate,
              onCopy: copyBlock,
            }}
            onChange={(blocks, kind) => setDesign({ ...design, blocks }, kind)}
          />
        </Section>
      </div>
      <Preview
        templateId={template.id}
        design={design}
        form={form}
        formId={formId}
        formTitle={formTitle}
        locale={locale}
        companyName={company.name}
        companyBrandColour={company.brandColour}
        logoMediaId={company.logoMediaId}
      />

      <Dialog
        open={recovery.kind !== 'none'}
        title={t('documents.pdfBuilder.recovery.title')}
        onClose={() => setRecovery({ kind: 'none' })}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                clearLocalCopy(recoveryKey);
                setRecovery({ kind: 'none' });
              }}
            >
              {t('documents.pdfBuilder.recovery.discard')}
            </Button>
            <Button
              variant={recovery.kind === 'stale' ? 'danger' : 'primary'}
              onClick={() => {
                if (recovery.kind !== 'none') {
                  const copy = recovery.copy.definition as unknown as Draft;
                  change({ design: designOf(copy.design), name: copy.name }, 'step');
                }
                setRecovery({ kind: 'none' });
              }}
            >
              {t('documents.pdfBuilder.recovery.restore')}
            </Button>
          </>
        }
      >
        {recovery.kind === 'none' ? null : (
          <p>
            {t(
              recovery.kind === 'stale'
                ? 'documents.pdfBuilder.recovery.staleBody'
                : 'documents.pdfBuilder.recovery.restoreBody',
              { when: formatDateTime(recovery.copy.savedAt, { locale }) },
            )}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4">
      <h3 className="text-base font-semibold text-content">{title}</h3>
      {children}
    </section>
  );
}

/** The server's reasons for refusing a save, one per line. */
function ServerProblems({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!(error instanceof ApiRequestError)) {
    return <ErrorState />;
  }
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-subtle p-3 text-sm">
      <p className="text-content">{t('documents.designer.problems')}</p>
      <ul className="mt-1 list-disc ps-5 text-content">
        {error.details.length === 0 ? <li>{error.message}</li> : null}
        {error.details.map((detail, index) => (
          <li key={index}>
            <code dir="ltr" className="text-xs">
              {detail.field.replace(/^body\.design\./u, '')}
            </code>{' '}
            {detail.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
