import { useTranslation } from '@integr8/i18n';
import { useId, useState } from 'react';
import { buttonClass, Failure, Field, inputClass, when } from './ui.js';

export interface AccessNotes {
  gateCode: string | null;
  parking: string | null;
  askFor: string | null;
  hazards: string | null;
  notes: string | null;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}

export type AccessInput = Pick<
  AccessNotes,
  'gateCode' | 'parking' | 'askFor' | 'hazards' | 'notes'
>;

/**
 * How to get in: the most-read part of a job.
 *
 * Hazards come first and look like a warning, because they are the one note
 * that must not be skimmed past. The gate code is large, because it is typed
 * into a keypad in the rain. A person allowed to correct the notes can do so in
 * place — the engineer who finds the code has changed is the first to know.
 */
export function AccessNotesPanel({
  access,
  locale,
  headingLevel = 2,
  onSave,
}: {
  access: AccessNotes;
  locale: string;
  headingLevel?: 2 | 3;
  /** Present when this person may correct the notes. */
  onSave?: (input: AccessInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const empty = [
    access.gateCode,
    access.parking,
    access.askFor,
    access.hazards,
    access.notes,
  ].every((value) => value === null || value === '');

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border-2 border-accent bg-surface p-4 text-start"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={headingId} className="text-lg font-semibold text-content">
          {t('operations.access.title')}
        </Heading>
        {onSave === undefined || editing ? null : (
          <button type="button" className={buttonClass.ghost} onClick={() => setEditing(true)}>
            {t('operations.access.edit')}
          </button>
        )}
      </div>

      {editing && onSave !== undefined ? (
        <AccessForm
          access={access}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            await onSave(input);
            setEditing(false);
          }}
        />
      ) : empty ? (
        <p className="text-sm text-content-muted">{t('operations.access.none')}</p>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {access.hazards === null ? null : (
            <div className="flex flex-col gap-1 rounded-md border border-danger bg-danger-subtle p-3 sm:col-span-2">
              <dt className="text-sm font-semibold text-danger">
                ⚠ {t('operations.access.hazards')}
              </dt>
              <dd dir="auto" className="whitespace-pre-wrap text-sm text-content">
                {access.hazards}
              </dd>
            </div>
          )}
          {access.gateCode === null ? null : (
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-muted">{t('operations.access.gateCode')}</dt>
              <dd
                dir="ltr"
                className="font-mono text-2xl font-semibold tracking-wider text-content"
              >
                {access.gateCode}
              </dd>
            </div>
          )}
          {access.askFor === null ? null : (
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-muted">{t('operations.access.askFor')}</dt>
              <dd dir="auto" className="text-sm text-content">
                {access.askFor}
              </dd>
            </div>
          )}
          {access.parking === null ? null : (
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-muted">{t('operations.access.parking')}</dt>
              <dd dir="auto" className="whitespace-pre-wrap text-sm text-content">
                {access.parking}
              </dd>
            </div>
          )}
          {access.notes === null ? null : (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-sm text-content-muted">{t('operations.access.notes')}</dt>
              <dd dir="auto" className="whitespace-pre-wrap text-sm text-content">
                {access.notes}
              </dd>
            </div>
          )}
        </dl>
      )}

      {access.updatedAt === null || editing ? null : (
        <p className="text-xs text-content-muted">
          {t('operations.access.updated', {
            when: when(access.updatedAt, locale),
            name: access.updatedBy?.name ?? '',
          })}
        </p>
      )}
    </section>
  );
}

function AccessForm({
  access,
  onSave,
  onCancel,
}: {
  access: AccessNotes;
  onSave: (input: AccessInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<AccessInput>({
    gateCode: access.gateCode,
    parking: access.parking,
    askFor: access.askFor,
    hazards: access.hazards,
    notes: access.notes,
  });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<unknown>(undefined);

  const text = (key: keyof AccessInput, multiline: boolean) => (
    <Field label={t(`operations.access.${key}`)} className={multiline ? 'sm:col-span-2' : ''}>
      {(id) =>
        multiline ? (
          <textarea
            id={id}
            rows={2}
            className={inputClass}
            value={values[key] ?? ''}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        ) : (
          <input
            id={id}
            className={inputClass}
            value={values[key] ?? ''}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        )
      }
    </Field>
  );

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setFailed(undefined);
        onSave(values)
          .catch((error: unknown) => setFailed(error))
          .finally(() => setSaving(false));
      }}
    >
      {text('hazards', true)}
      {text('gateCode', false)}
      {text('askFor', false)}
      {text('parking', true)}
      {text('notes', true)}
      {failed === undefined ? null : (
        <div className="sm:col-span-2">
          <Failure error={failed} />
        </div>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className={buttonClass.primary} disabled={saving} aria-busy={saving}>
          {t('operations.access.save')}
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
