import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type JobType, keys, type Priority, useOperations } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, inputClass, Loading } from '../ui.js';

interface Draft {
  id?: string;
  name: string;
  code: string;
  description: string;
  duration: string;
  defaultPriority: Priority;
  instructions: string;
  checklist: { id?: string; label: string }[];
  forms: { formId: string; required: boolean }[];
  beforePhotos: string;
  afterPhotos: string;
  signatureRequired: boolean;
}

const EMPTY: Draft = {
  name: '',
  code: '',
  description: '',
  duration: '',
  defaultPriority: 'normal',
  instructions: '',
  checklist: [],
  forms: [],
  beforePhotos: '0',
  afterPhotos: '0',
  signatureRequired: false,
};

const MAX_PHOTOS = 20;

/** A photo count as typed, as the whole number the API takes: empty is none. */
function photoCount(value: string): number {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) ? Math.min(MAX_PHOTOS, Math.max(0, count)) : 0;
}

function toDraft(type: JobType): Draft {
  return {
    id: type.id,
    name: type.name,
    code: type.code,
    description: type.description ?? '',
    duration: type.expectedDurationMinutes === null ? '' : String(type.expectedDurationMinutes),
    defaultPriority: type.defaultPriority,
    instructions: type.instructions ?? '',
    checklist: type.checklist.map((item) => ({ id: item.id, label: item.label })),
    forms: type.forms.map((form) => ({ formId: form.formId, required: form.required })),
    beforePhotos: String(type.beforePhotos),
    afterPhotos: String(type.afterPhotos),
    signatureRequired: type.signatureRequired,
  };
}

/**
 * The kinds of job a company does, and what each carries onto a new job: its
 * forms (some required before the job can complete), a checklist,
 * instructions, and how long it usually takes.
 */
export function JobTypesScreen() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Draft | undefined>(undefined);
  const types = useQuery({
    queryKey: keys.jobTypes(archived),
    queryFn: async () =>
      (
        await client.GET('/v1/job-types', {
          params: { query: archived ? { includeArchived: 'true' } : {} },
        })
      ).data!.items,
  });
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const manage = me.data?.permissions.includes('job_type.manage') ?? false;

  return (
    <div className="flex flex-col gap-6 text-start">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('operations.jobTypes.title')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            {t('operations.jobTypes.showArchived')}
          </label>
          {manage ? (
            <button type="button" className={buttonClass.primary} onClick={() => setEditing(EMPTY)}>
              {t('operations.jobTypes.new')}
            </button>
          ) : null}
        </div>
      </header>

      {types.isPending ? (
        <Loading />
      ) : types.isError ? (
        <Failure error={types.error} onRetry={() => void types.refetch()} />
      ) : types.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('operations.jobTypes.empty')}
        </p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {types.data.map((type) => (
            <li key={type.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col">
                  <h2 className="text-lg font-semibold text-content">
                    {type.name}
                    {type.archived ? (
                      <span className="ms-2 text-sm font-normal text-content-muted">
                        ({t('operations.jobTypes.archived')})
                      </span>
                    ) : null}
                  </h2>
                  <span className="font-mono text-xs text-content-muted">{type.code}</span>
                </div>
                {manage ? (
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() => setEditing(toDraft(type))}
                  >
                    {t('operations.common.edit')}
                  </button>
                ) : null}
              </div>
              {type.description === null ? null : (
                <p className="text-sm text-content">{type.description}</p>
              )}
              <p className="text-xs text-content-muted">
                {type.expectedDurationMinutes === null
                  ? t(`operations.priority.${type.defaultPriority}`)
                  : `${t('operations.workOrder.expectedDuration', { minutes: type.expectedDurationMinutes })} · ${t(`operations.priority.${type.defaultPriority}`)}`}
              </p>
              {type.beforePhotos === 0 &&
              type.afterPhotos === 0 &&
              !type.signatureRequired ? null : (
                <p className="text-xs text-content-muted">
                  {[
                    type.beforePhotos === 0
                      ? ''
                      : t('operations.jobTypes.beforePhotosCount', { count: type.beforePhotos }),
                    type.afterPhotos === 0
                      ? ''
                      : t('operations.jobTypes.afterPhotosCount', { count: type.afterPhotos }),
                    type.signatureRequired ? t('operations.jobTypes.signs') : '',
                  ]
                    .filter((part) => part !== '')
                    .join(' · ')}
                </p>
              )}
              <ul className="flex flex-col gap-0.5 text-sm">
                {type.forms.map((form) => (
                  <li key={form.formId} className="text-content">
                    {form.title}{' '}
                    <span className="text-xs text-content-muted">
                      (
                      {form.required
                        ? t('operations.workOrder.required')
                        : t('operations.workOrder.optional')}
                      )
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {editing === undefined ? null : (
        <JobTypeDialog draft={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}

function JobTypeDialog({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(initial);
  const [adding, setAdding] = useState('');
  const forms = useQuery({
    queryKey: keys.forms,
    queryFn: async () => (await client.GET('/v1/forms')).data!.items,
  });

  const body = () => ({
    name: draft.name.trim(),
    code: draft.code.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    expectedDurationMinutes: draft.duration === '' ? null : Number(draft.duration),
    defaultPriority: draft.defaultPriority,
    instructions: draft.instructions.trim() === '' ? null : draft.instructions.trim(),
    checklist: draft.checklist
      .filter((item) => item.label.trim() !== '')
      .map((item) => ({
        ...(item.id === undefined ? {} : { id: item.id }),
        label: item.label.trim(),
      })),
    forms: draft.forms,
    beforePhotos: photoCount(draft.beforePhotos),
    afterPhotos: photoCount(draft.afterPhotos),
    signatureRequired: draft.signatureRequired,
  });

  const save = useMutation({
    mutationFn: async () =>
      initial.id === undefined
        ? (
            await client.POST('/v1/job-types', {
              params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
              body: body(),
            })
          ).data!
        : (
            await client.PATCH('/v1/job-types/{jobTypeId}', {
              params: { path: { jobTypeId: initial.id } },
              body: body(),
            })
          ).data!,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job-types'] });
      onClose();
    },
  });
  const archive = useMutation({
    mutationFn: async (archived: boolean) =>
      client.PATCH('/v1/job-types/{jobTypeId}', {
        params: { path: { jobTypeId: initial.id! } },
        body: { archived },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['job-types'] });
      onClose();
    },
  });

  const titleOf = (formId: string) => forms.data?.find((form) => form.id === formId)?.title ?? '';
  const move = (index: number, by: -1 | 1) => {
    const next = [...draft.checklist];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    setDraft({ ...draft, checklist: next });
  };

  return (
    <Dialog
      wide
      title={initial.id === undefined ? t('operations.jobTypes.new') : draft.name}
      onClose={onClose}
      footer={
        <>
          {initial.id === undefined ? null : (
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => archive.mutate(true)}
            >
              {t('operations.jobTypes.archive')}
            </button>
          )}
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={draft.name.trim() === '' || draft.code.trim() === '' || save.isPending}
            aria-busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {initial.id === undefined
              ? t('operations.jobTypes.create')
              : t('operations.jobTypes.save')}
          </button>
        </>
      }
    >
      <p className="text-xs text-content-muted">{t('operations.jobTypes.appliesHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('operations.jobTypes.name')}>
          {(id) => (
            <input
              id={id}
              required
              className={inputClass}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('operations.jobTypes.code')} hint={t('operations.jobTypes.codeHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              required
              aria-describedby={describedBy}
              className={`${inputClass} font-mono uppercase`}
              value={draft.code}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('operations.jobTypes.duration')}>
          {(id) => (
            <input
              id={id}
              type="number"
              min={1}
              max={10080}
              className={inputClass}
              value={draft.duration}
              onChange={(event) => setDraft({ ...draft, duration: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('operations.jobTypes.defaultPriority')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.defaultPriority}
              onChange={(event) =>
                setDraft({ ...draft, defaultPriority: event.target.value as Priority })
              }
            >
              {(['low', 'normal', 'high', 'urgent'] as const).map((option) => (
                <option key={option} value={option}>
                  {t(`operations.priority.${option}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.jobTypes.description')} className="sm:col-span-2">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              className={inputClass}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('operations.jobTypes.instructions')} className="sm:col-span-2">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              className={inputClass}
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          )}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-content">
          {t('operations.jobTypes.completion')}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['beforePhotos', 'afterPhotos'] as const).map((field) => (
            <Field
              key={field}
              label={t(`operations.jobTypes.${field}`)}
              hint={t('operations.jobTypes.photosHint')}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_PHOTOS}
                  step={1}
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={draft[field]}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={draft.signatureRequired}
            onChange={(event) => setDraft({ ...draft, signatureRequired: event.target.checked })}
          />
          {t('operations.jobTypes.signatureRequired')}
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-content">
          {t('operations.jobTypes.checklist')}
        </legend>
        <ol className="flex flex-col gap-2">
          {draft.checklist.map((item, index) => (
            <li key={item.id ?? `new-${String(index)}`} className="flex items-center gap-2">
              <label className="sr-only" htmlFor={`checklist-${String(index)}`}>
                {t('operations.jobTypes.itemLabel', { number: index + 1 })}
              </label>
              <input
                id={`checklist-${String(index)}`}
                className={inputClass}
                value={item.label}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    checklist: draft.checklist.map((entry, position) =>
                      position === index ? { ...entry, label: event.target.value } : entry,
                    ),
                  })
                }
              />
              <button
                type="button"
                className={buttonClass.ghost}
                disabled={index === 0}
                aria-label={t('operations.jobTypes.moveUp', { number: index + 1 })}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={buttonClass.ghost}
                disabled={index === draft.checklist.length - 1}
                aria-label={t('operations.jobTypes.moveDown', { number: index + 1 })}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className={buttonClass.ghost}
                aria-label={t('operations.jobTypes.removeItem', { number: index + 1 })}
                onClick={() =>
                  setDraft({
                    ...draft,
                    checklist: draft.checklist.filter((_, position) => position !== index),
                  })
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`${buttonClass.ghost} self-start`}
          onClick={() => setDraft({ ...draft, checklist: [...draft.checklist, { label: '' }] })}
        >
          + {t('operations.jobTypes.addItem')}
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-content">
          {t('operations.jobTypes.forms')}
        </legend>
        {draft.forms.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.jobTypes.noForms')}</p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {draft.forms.map((form) => (
            <li
              key={form.formId}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="text-content">{titleOf(form.formId)}</span>
              <span className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-content">
                  <input
                    type="checkbox"
                    checked={form.required}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        forms: draft.forms.map((entry) =>
                          entry.formId === form.formId
                            ? { ...entry, required: event.target.checked }
                            : entry,
                        ),
                      })
                    }
                  />
                  {t('operations.jobTypes.requiredForm')}
                </label>
                <button
                  type="button"
                  className={buttonClass.ghost}
                  aria-label={t('operations.jobTypes.removeForm', { title: titleOf(form.formId) })}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      forms: draft.forms.filter((entry) => entry.formId !== form.formId),
                    })
                  }
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-end gap-2">
          <Field label={t('operations.jobTypes.addForm')} className="flex-1">
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
              >
                <option value="">{t('operations.jobTypes.chooseForm')}</option>
                {forms.data
                  ?.filter(
                    (form) =>
                      form.latestVersionNumber !== null &&
                      !draft.forms.some((entry) => entry.formId === form.id),
                  )
                  .map((form) => (
                    <option key={form.id} value={form.id}>
                      {form.title}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={adding === ''}
            onClick={() => {
              setDraft({ ...draft, forms: [...draft.forms, { formId: adding, required: true }] });
              setAdding('');
            }}
          >
            {t('operations.common.add')}
          </button>
        </div>
      </fieldset>

      {save.isError ? <Failure error={save.error} /> : null}
      {archive.isError ? <Failure error={archive.error} /> : null}
    </Dialog>
  );
}
