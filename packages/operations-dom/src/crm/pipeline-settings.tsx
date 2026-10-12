import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { keys, type PipelineDetail, type PipelineStage, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  usePermissions,
} from '../ui.js';
import { formatChance, usePipelines, useStageName } from './opportunity-parts.js';

/**
 * Pipelines and their stages (eighth round; ADR-0012). Owners and admins
 * (`crm.pipeline.manage`) add, rename, reorder and archive them; everybody
 * else who reads the CRM sees them as they are. A stage's key never changes,
 * so the standard stages keep their translated names whatever they are
 * called; archiving a stage that still holds open opportunities asks which
 * open stage they move to.
 */

type Outcome = PipelineStage['outcome'];
const OUTCOMES: readonly Outcome[] = ['open', 'won', 'lost'];

/** A typed percentage as whole basis points: `37.5` → 3750; undefined when it is not one. */
export function basisPointsOf(text: string): number | undefined {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return value <= 10_000 ? value : undefined;
}

/** Whole basis points as the percentage typed: 3750 → `37.5`. */
export function percentOf(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const rest = basisPoints % 100;
  return rest === 0
    ? String(whole)
    : `${whole}.${String(rest).padStart(2, '0').replace(/0$/u, '')}`;
}

function linkProps(to: string, navigate: (to: string) => void) {
  return {
    href: to,
    className: 'text-accent underline-offset-4 hover:underline',
    onClick: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      navigate(to);
    },
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Every pipeline, the default first, and — for those who keep them — a new one. */
export function PipelineListScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const permissions = usePermissions();
  const manage = permissions.includes('crm.pipeline.manage');
  const pipelines = usePipelines();
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  // One key per name: a retry replays, a changed name is a new request.
  const idempotencyKey = useMemo(() => (name === '' ? '' : crypto.randomUUID()), [name]);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/pipelines', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { name: name.trim() },
        })
      ).data!,
    onSuccess: async (created) => {
      queries.setQueryData(keys.pipeline(created.id), created);
      await queries.invalidateQueries({ queryKey: keys.pipelines });
      navigate(paths.crmPipeline(created.id));
    },
  });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crmOpportunities} label={t('crm.opportunities.back')} />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('crm.pipelines.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('crm.pipelines.intro')}</p>
      </header>

      {pipelines.isPending ? (
        <Loading />
      ) : pipelines.isError ? (
        <Failure error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : pipelines.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">{t('crm.pipelines.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {pipelines.data.map((pipeline) => (
            <li
              key={pipeline.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <span className="flex flex-wrap items-center gap-2">
                <a {...linkProps(paths.crmPipeline(pipeline.id), navigate)} dir="auto">
                  {pipeline.name}
                </a>
                {pipeline.isDefault ? <DefaultBadge /> : null}
              </span>
              <span className="text-sm text-content-muted">
                {t('crm.pipelines.stageCount', {
                  count: pipeline.stages.filter((stage) => !stage.archived).length,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {manage ? (
        <form
          aria-labelledby="crm-pipeline-new"
          className={cardClass}
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setTried(true);
            if (name.trim() !== '') {
              create.mutate();
            }
          }}
        >
          <h2 id="crm-pipeline-new" className="text-base font-semibold text-content">
            {t('crm.pipelines.newTitle')}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label={t('crm.pipelines.name')}
              hint={
                tried && name.trim() === ''
                  ? t('crm.pipelines.nameRequired')
                  : t('crm.pipelines.newHint')
              }
              className="min-w-64 flex-1"
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  type="text"
                  dir="auto"
                  maxLength={100}
                  aria-describedby={describedBy}
                  aria-invalid={tried && name.trim() === ''}
                  className={inputClass}
                  value={name}
                  onChange={(event) => {
                    create.reset();
                    setName(event.target.value);
                  }}
                />
              )}
            </Field>
            <button type="submit" className={buttonClass.primary} disabled={create.isPending}>
              {create.isPending ? t('crm.pipelines.creating') : t('crm.pipelines.create')}
            </button>
          </div>
          {create.isError ? <Failure error={create.error} /> : null}
        </form>
      ) : permissions.length > 0 ? (
        <p className="text-sm text-content-muted">{t('crm.pipelines.readOnly')}</p>
      ) : null}
    </div>
  );
}

function DefaultBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-content">
      {t('crm.pipelines.default')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One pipeline
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: 'rename' }
  | { kind: 'archive' }
  | { kind: 'addStage' }
  | { kind: 'editStage'; stage: PipelineStage }
  | { kind: 'archiveStage'; stage: PipelineStage };

/** One pipeline: its stages with what stands in each, and — for those who keep them — the edits. */
export function PipelineScreen({ pipelineId }: { pipelineId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const stageName = useStageName();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState('');
  // After a move, the button pressed keeps the focus, wherever its row went.
  const focusAfter = useRef<string | null>(null);

  const detail = useQuery({
    queryKey: keys.pipeline(pipelineId),
    queryFn: async () =>
      (await client.GET('/v1/crm/pipelines/{pipelineId}', { params: { path: { pipelineId } } }))
        .data!,
  });
  const settle = async (next: PipelineDetail) => {
    setDialog(null);
    queries.setQueryData(keys.pipeline(next.id), next);
    await queries.invalidateQueries({ queryKey: keys.pipelines });
    await queries.invalidateQueries({ queryKey: ['crm', 'opportunities'] });
  };

  const makeDefault = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/crm/pipelines/{pipelineId}', {
          params: { path: { pipelineId } },
          body: { isDefault: true },
        })
      ).data!,
    onSuccess: settle,
  });
  const reorder = useMutation({
    mutationFn: async (input: { stageIds: string[]; moved: PipelineStage; focus: string }) =>
      (
        await client.PUT('/v1/crm/pipelines/{pipelineId}/stages/order', {
          params: { path: { pipelineId } },
          body: { stageIds: input.stageIds },
        })
      ).data!,
    onSuccess: async (next, input) => {
      focusAfter.current = input.focus;
      await settle(next);
      setNotice(
        t('crm.pipelines.reordered', {
          stage: stageName(input.moved),
          position: input.stageIds.indexOf(input.moved.id) + 1,
          of: input.stageIds.length,
        }),
      );
    },
  });

  useEffect(() => {
    if (focusAfter.current === null) {
      return;
    }
    const [id, direction] = focusAfter.current.split(':');
    const wanted = document.getElementById(`stage-${id}-${direction}`);
    const other = document.getElementById(`stage-${id}-${direction === 'up' ? 'down' : 'up'}`);
    const target = wanted instanceof HTMLButtonElement && !wanted.disabled ? wanted : other;
    target?.focus();
    focusAfter.current = null;
  }, [detail.data]);

  const back = <BackLink to={paths.crmPipelines} label={t('crm.pipelines.back')} />;
  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Loading />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const pipeline = detail.data;
  const edit = pipeline.can.edit;
  const current = pipeline.stages
    .filter((stage) => !stage.archived)
    .sort((a, b) => a.position - b.position);
  const archived = pipeline.stages.filter((stage) => stage.archived);
  const busy = reorder.isPending || makeDefault.isPending;

  const move = (stage: PipelineStage, by: -1 | 1) => {
    const ids = current.map((candidate) => candidate.id);
    const from = ids.indexOf(stage.id);
    const to = from + by;
    if (to < 0 || to >= ids.length) {
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, stage.id);
    setNotice('');
    reorder.mutate({
      stageIds: ids,
      moved: stage,
      focus: `${stage.id}:${by === -1 ? 'up' : 'down'}`,
    });
  };

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span dir="auto" className="break-words">
              {pipeline.name}
            </span>
            {pipeline.isDefault ? <DefaultBadge /> : null}
          </h1>
          <p className="max-w-prose text-sm text-content-muted">
            {edit ? t('crm.pipelines.stagesHint') : t('crm.pipelines.readOnly')}
          </p>
        </div>
        {edit ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setDialog({ kind: 'rename' })}
            >
              {t('crm.pipelines.rename')}
            </button>
            {pipeline.isDefault ? null : (
              <>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={() => makeDefault.mutate()}
                >
                  {t('crm.pipelines.makeDefault')}
                </button>
                <button
                  type="button"
                  className={buttonClass.danger}
                  onClick={() => setDialog({ kind: 'archive' })}
                >
                  {t('crm.pipelines.archive')}
                </button>
              </>
            )}
          </div>
        ) : null}
      </header>

      {makeDefault.isError ? <Failure error={makeDefault.error} /> : null}
      {reorder.isError ? (
        <Failure error={reorder.error} onRetry={() => void detail.refetch()} />
      ) : null}
      <p role="status" aria-live="polite" className="text-sm text-content empty:hidden">
        {notice}
      </p>

      <section aria-labelledby="crm-pipeline-stages" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="crm-pipeline-stages" className="text-base font-semibold text-content">
            {t('crm.pipelines.stages')}
          </h2>
          {edit ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setDialog({ kind: 'addStage' })}
            >
              {t('crm.pipelines.addStage')}
            </button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('crm.pipelines.stages')}</caption>
            <thead className="border-b border-border-subtle text-xs text-content-muted">
              <tr>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t('crm.pipelines.stage')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  {t('crm.pipelines.chance')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('crm.pipelines.outcome')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  {t('crm.pipelines.openCount')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  {t('crm.pipelines.closedCount')}
                </th>
                {edit ? (
                  <th scope="col" className="py-2 ps-3 text-end font-medium">
                    <span className="sr-only">{t('crm.pipelines.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {current.map((stage, index) => {
                const name = stageName(stage);
                return (
                  <tr key={stage.id}>
                    <th scope="row" className="py-2 pe-3 text-start font-medium text-content">
                      <span dir="auto">{name}</span>
                    </th>
                    <td className="px-3 py-2 text-end tabular-nums">
                      {formatChance(stage.probabilityBp, locale)}
                    </td>
                    <td className="px-3 py-2">{t(`crm.pipelines.outcomes.${stage.outcome}`)}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{stage.openCount}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{stage.closedCount}</td>
                    {edit ? (
                      <td className="py-2 ps-3">
                        <div className="flex flex-wrap justify-end gap-1">
                          <button
                            id={`stage-${stage.id}-up`}
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('crm.pipelines.moveUp', { stage: name })}
                            disabled={index === 0 || busy}
                            onClick={() => move(stage, -1)}
                          >
                            <span aria-hidden="true">↑</span>
                          </button>
                          <button
                            id={`stage-${stage.id}-down`}
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('crm.pipelines.moveDown', { stage: name })}
                            disabled={index === current.length - 1 || busy}
                            onClick={() => move(stage, 1)}
                          >
                            <span aria-hidden="true">↓</span>
                          </button>
                          <button
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('crm.pipelines.editStageLabel', { stage: name })}
                            onClick={() => setDialog({ kind: 'editStage', stage })}
                          >
                            {t('crm.pipelines.editStage')}
                          </button>
                          <button
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('crm.pipelines.archiveStageLabel', { stage: name })}
                            onClick={() => setDialog({ kind: 'archiveStage', stage })}
                          >
                            {t('crm.pipelines.archiveStage')}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {archived.length === 0 ? null : (
        <section aria-labelledby="crm-pipeline-archived" className={cardClass}>
          <h2 id="crm-pipeline-archived" className="text-base font-semibold text-content">
            {t('crm.pipelines.archived')}
          </h2>
          <p className="text-sm text-content-muted">{t('crm.pipelines.archivedHint')}</p>
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {archived.map((stage) => (
              <li key={stage.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span dir="auto" className="text-content">
                  {stageName(stage)}
                </span>
                <span className="text-content-muted">
                  {t('crm.pipelines.closedIn', { count: stage.closedCount })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === 'rename' ? (
        <RenameDialog pipeline={pipeline} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog?.kind === 'archive' ? (
        <ArchivePipelineDialog
          pipeline={pipeline}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            queries.removeQueries({ queryKey: keys.pipeline(pipeline.id) });
            await queries.invalidateQueries({ queryKey: keys.pipelines });
            navigate(paths.crmPipelines);
          }}
        />
      ) : null}
      {dialog?.kind === 'addStage' ? (
        <StageDialog pipeline={pipeline} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog?.kind === 'editStage' ? (
        <StageDialog
          pipeline={pipeline}
          stage={dialog.stage}
          onClose={() => setDialog(null)}
          onDone={settle}
        />
      ) : null}
      {dialog?.kind === 'archiveStage' ? (
        <ArchiveStageDialog
          pipeline={pipeline}
          stage={dialog.stage}
          onClose={() => setDialog(null)}
          onDone={async (next, moved) => {
            await settle(next);
            setNotice(
              moved === 0
                ? t('crm.pipelines.stageArchived', { stage: stageName(dialog.stage) })
                : t('crm.pipelines.moved', { stage: stageName(dialog.stage), count: moved }),
            );
          }}
        />
      ) : null}
    </div>
  );
}

function RenameDialog({
  pipeline,
  onClose,
  onDone,
}: {
  pipeline: PipelineDetail;
  onClose: () => void;
  onDone: (next: PipelineDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const formId = useId();
  const [name, setName] = useState(pipeline.name);
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/crm/pipelines/{pipelineId}', {
          params: { path: { pipelineId: pipeline.id } },
          body: { name: name.trim() },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('crm.pipelines.renameTitle', { name: pipeline.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('crm.pipelines.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={save.isPending}
          >
            {save.isPending ? t('crm.pipelines.saving') : t('crm.pipelines.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (name.trim() !== '') {
            save.mutate();
          }
        }}
      >
        <Field
          label={t('crm.pipelines.name')}
          {...(tried && name.trim() === '' ? { hint: t('crm.pipelines.nameRequired') } : {})}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="text"
              dir="auto"
              maxLength={100}
              aria-describedby={describedBy}
              aria-invalid={tried && name.trim() === ''}
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {save.isError ? <Failure error={save.error} /> : null}
      </form>
    </Dialog>
  );
}

function ArchivePipelineDialog({
  pipeline,
  onClose,
  onDone,
}: {
  pipeline: PipelineDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const archive = useMutation({
    mutationFn: async () => {
      await client.DELETE('/v1/crm/pipelines/{pipelineId}', {
        params: { path: { pipelineId: pipeline.id } },
      });
    },
    onSuccess: onDone,
  });
  const open = pipeline.stages.reduce((sum, stage) => sum + stage.openCount, 0);
  return (
    <Dialog
      title={t('crm.pipelines.archiveTitle', { name: pipeline.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('crm.pipelines.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            {archive.isPending ? t('crm.pipelines.archiving') : t('crm.pipelines.archive')}
          </button>
        </>
      }
    >
      <p>{t('crm.pipelines.archiveIntro')}</p>
      {open > 0 ? (
        <p className="text-content-muted">{t('crm.pipelines.archiveHasOpen', { count: open })}</p>
      ) : null}
      {archive.isError ? <Failure error={archive.error} /> : null}
    </Dialog>
  );
}

/** Adds a stage at the end, or changes one's name, usual chance or outcome. */
function StageDialog({
  pipeline,
  stage,
  onClose,
  onDone,
}: {
  pipeline: PipelineDetail;
  stage?: PipelineStage;
  onClose: () => void;
  onDone: (next: PipelineDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const stageName = useStageName();
  const formId = useId();
  const [label, setLabel] = useState(stage?.label ?? '');
  const [chance, setChance] = useState(stage === undefined ? '' : percentOf(stage.probabilityBp));
  const [outcome, setOutcome] = useState<Outcome>(stage?.outcome ?? 'open');
  const [tried, setTried] = useState(false);
  const basisPoints = basisPointsOf(chance);
  const problems = { label: label.trim() === '', chance: basisPoints === undefined };
  const body = {
    label: label.trim(),
    probabilityBp: basisPoints ?? 0,
    outcome,
  };
  const bodyText = JSON.stringify(body);
  const idempotencyKey = useMemo(() => (bodyText === '' ? '' : crypto.randomUUID()), [bodyText]);

  const save = useMutation({
    mutationFn: async () => {
      if (stage === undefined) {
        return (
          await client.POST('/v1/crm/pipelines/{pipelineId}/stages', {
            params: {
              path: { pipelineId: pipeline.id },
              header: { 'Idempotency-Key': idempotencyKey },
            },
            body,
          })
        ).data!;
      }
      // Only what changed, so an outcome is never "changed" to itself.
      return (
        await client.PATCH('/v1/crm/pipelines/{pipelineId}/stages/{stageId}', {
          params: { path: { pipelineId: pipeline.id, stageId: stage.id } },
          body: {
            ...(body.label === stage.label ? {} : { label: body.label }),
            ...(body.probabilityBp === stage.probabilityBp
              ? {}
              : { probabilityBp: body.probabilityBp }),
            ...(body.outcome === stage.outcome ? {} : { outcome: body.outcome }),
          },
        })
      ).data!;
    },
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={
        stage === undefined
          ? t('crm.pipelines.addStageTitle')
          : t('crm.pipelines.editStageTitle', { stage: stageName(stage) })
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('crm.pipelines.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={save.isPending}
          >
            {save.isPending
              ? t('crm.pipelines.saving')
              : stage === undefined
                ? t('crm.pipelines.addStage')
                : t('crm.pipelines.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!problems.label && !problems.chance) {
            save.mutate();
          }
        }}
      >
        {stage === undefined ? <p>{t('crm.pipelines.addStageHint')}</p> : null}
        <Field
          label={t('crm.pipelines.label')}
          hint={
            tried && problems.label
              ? t('crm.pipelines.nameRequired')
              : stage !== undefined && stageName(stage) !== stage.label
                ? t('crm.pipelines.standardHint')
                : t('crm.pipelines.labelHint')
          }
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="text"
              dir="auto"
              maxLength={100}
              aria-describedby={describedBy}
              aria-invalid={tried && problems.label}
              className={inputClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('crm.pipelines.chanceLabel')}
          hint={
            tried && problems.chance
              ? t('crm.pipelines.chanceInvalid')
              : t('crm.opportunities.chanceHint')
          }
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="text"
              inputMode="decimal"
              dir="ltr"
              aria-describedby={describedBy}
              aria-invalid={tried && problems.chance}
              className={`${inputClass} max-w-32`}
              value={chance}
              onChange={(event) => setChance(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('crm.pipelines.outcome')}
          {...(stage === undefined ? {} : { hint: t('crm.pipelines.outcomeHint') })}
        >
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as Outcome)}
            >
              {OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {t(`crm.pipelines.outcomes.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {save.isError ? <Failure error={save.error} /> : null}
      </form>
    </Dialog>
  );
}

/**
 * Archives a stage. One that holds open opportunities asks which open stage
 * of the same pipeline they move to; each move goes into its history.
 */
function ArchiveStageDialog({
  pipeline,
  stage,
  onClose,
  onDone,
}: {
  pipeline: PipelineDetail;
  stage: PipelineStage;
  onClose: () => void;
  onDone: (next: PipelineDetail, moved: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const stageName = useStageName();
  const [target, setTarget] = useState('');
  const [tried, setTried] = useState(false);
  const targets = pipeline.stages
    .filter(
      (candidate) =>
        !candidate.archived && candidate.outcome === 'open' && candidate.id !== stage.id,
    )
    .sort((a, b) => a.position - b.position);
  const archive = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/pipelines/{pipelineId}/stages/{stageId}/archive', {
          params: { path: { pipelineId: pipeline.id, stageId: stage.id } },
          body: target === '' ? {} : { moveToStageId: target },
        })
      ).data!,
    onSuccess: async (result) => onDone(result.pipeline, result.moved),
  });
  // Somebody may have opened one there since the counts were read.
  const needsTarget =
    stage.openCount > 0 ||
    (archive.error instanceof ApiRequestError && archive.error.code === 'move_required');
  const name = stageName(stage);

  return (
    <Dialog
      title={t('crm.pipelines.archiveStageTitle', { stage: name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('crm.pipelines.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={archive.isPending || (needsTarget && targets.length === 0)}
            onClick={() => {
              setTried(true);
              if (!needsTarget || target !== '') {
                archive.mutate();
              }
            }}
          >
            {archive.isPending ? t('crm.pipelines.archiving') : t('crm.pipelines.archiveStage')}
          </button>
        </>
      }
    >
      <p>{t('crm.pipelines.archiveStageIntro')}</p>
      {needsTarget ? (
        targets.length === 0 ? (
          <p className="text-content">{t('crm.pipelines.noOpenTarget')}</p>
        ) : (
          <Field
            label={t('crm.pipelines.moveTo')}
            hint={
              tried && target === ''
                ? t('crm.pipelines.moveToRequired')
                : t('crm.pipelines.moveToHint', { count: stage.openCount })
            }
          >
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={tried && target === ''}
                className={inputClass}
                value={target}
                onChange={(event) => {
                  archive.reset();
                  setTarget(event.target.value);
                }}
              >
                <option value="">{t('crm.pipelines.chooseStage')}</option>
                {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {stageName(candidate)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )
      ) : null}
      {archive.isError ? <Failure error={archive.error} /> : null}
    </Dialog>
  );
}
