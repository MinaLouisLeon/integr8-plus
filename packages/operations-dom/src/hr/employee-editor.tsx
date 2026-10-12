import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type Employee,
  type EmployeeCreateBody,
  type EmployeeUpdateBody,
  keys,
  type SealedFieldName,
  useOperations,
} from '../api.js';
import { useMembers } from '../crm/lead-parts.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  HrFailure,
  isSecret,
  Notice,
  SEALED_FIELDS,
  SECRET_PATTERN,
  useHrAccess,
} from './hr-parts.js';

/** A sealed number as typed: empty leaves it as it is, `clear` removes it. */
interface SecretDraft {
  value: string;
  clear: boolean;
}

const PLAIN_FIELDS = [
  'employeeNumber',
  'jobTitle',
  'department',
  'phone',
  'emergencyContactName',
  'emergencyContactPhone',
] as const;
type PlainField = (typeof PLAIN_FIELDS)[number];

interface Draft extends Record<PlainField, string>, Record<SealedFieldName, SecretDraft> {
  link: 'member' | 'standalone';
  userId: string;
  fullName: string;
  hireDate: string;
  bankName: string;
}

const NO_SECRET: SecretDraft = { value: '', clear: false };

function blankDraft(hireDate: string): Draft {
  return {
    link: 'member',
    userId: '',
    fullName: '',
    hireDate,
    employeeNumber: '',
    jobTitle: '',
    department: '',
    phone: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    bankName: '',
    nationalId: NO_SECRET,
    insuranceNumber: NO_SECRET,
    bankAccount: NO_SECRET,
  };
}

/** What an employee's profile says, as the form starts from. Sealed numbers start empty. */
function draftOf(employee: Employee): Draft {
  return {
    link: employee.member === null ? 'standalone' : 'member',
    userId: employee.member?.userId ?? '',
    fullName: employee.fullName,
    hireDate: employee.hireDate,
    employeeNumber: employee.employeeNumber ?? '',
    jobTitle: employee.jobTitle ?? '',
    department: employee.department ?? '',
    phone: employee.phone ?? '',
    emergencyContactName: employee.emergencyContact.name ?? '',
    emergencyContactPhone: employee.emergencyContact.phone ?? '',
    bankName: employee.sensitive?.bankName ?? '',
    nationalId: NO_SECRET,
    insuranceNumber: NO_SECRET,
    bankAccount: NO_SECRET,
  };
}

/** An employee's own value of a plain field, as the API names it. */
function currentValue(employee: Employee, field: PlainField | 'bankName'): string | null {
  switch (field) {
    case 'emergencyContactName':
      return employee.emergencyContact.name;
    case 'emergencyContactPhone':
      return employee.emergencyContact.phone;
    case 'bankName':
      return employee.sensitive?.bankName ?? null;
    default:
      return employee[field];
  }
}

const orNull = (text: string) => (text.trim() === '' ? null : text.trim());

/** What a new profile sends: only what was typed, sealed numbers only for those who keep them. */
function createBody(draft: Draft, sensitive: boolean): EmployeeCreateBody {
  const body: EmployeeCreateBody = { hireDate: draft.hireDate };
  if (draft.link === 'member') {
    body.userId = draft.userId;
  } else {
    body.fullName = draft.fullName.trim();
  }
  const optional: (PlainField | 'bankName')[] = sensitive
    ? [...PLAIN_FIELDS, 'bankName']
    : [...PLAIN_FIELDS];
  for (const field of optional) {
    const value = orNull(draft[field]);
    if (value !== null) {
      body[field] = value;
    }
  }
  if (sensitive) {
    for (const field of SEALED_FIELDS) {
      const value = orNull(draft[field].value);
      if (value !== null) {
        body[field] = value;
      }
    }
  }
  return body;
}

/**
 * What a change sends: only the fields that differ from the profile, so the
 * audit names what changed. A sealed number left empty is not sent; cleared,
 * it is sent as null.
 */
function updateBody(draft: Draft, employee: Employee, sensitive: boolean): EmployeeUpdateBody {
  const body: EmployeeUpdateBody = { expectedVersion: employee.version };
  const linkedTo = employee.member?.userId ?? null;
  if (draft.link === 'member') {
    if (draft.userId !== linkedTo) {
      body.userId = draft.userId;
    }
  } else {
    if (linkedTo !== null) {
      body.userId = null;
    }
    const name = draft.fullName.trim();
    if (name !== employee.fullName || linkedTo !== null) {
      body.fullName = name;
    }
  }
  if (draft.hireDate !== employee.hireDate) {
    body.hireDate = draft.hireDate;
  }
  const plain: (PlainField | 'bankName')[] = sensitive
    ? [...PLAIN_FIELDS, 'bankName']
    : [...PLAIN_FIELDS];
  for (const field of plain) {
    const value = orNull(draft[field]);
    if (value !== currentValue(employee, field)) {
      body[field] = value;
    }
  }
  if (sensitive) {
    for (const field of SEALED_FIELDS) {
      const secret = draft[field];
      if (secret.clear) {
        body[field] = null;
      } else if (secret.value.trim() !== '') {
        body[field] = secret.value.trim();
      }
    }
  }
  return body;
}

/** Today in the reader's own calendar, as the API writes a date. */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Adds an employee or changes one (ADR-0010). A profile is linked to a member
 * — their name comes from the membership — or stands alone for somebody who
 * never signs in. ID, insurance and bank numbers are offered only to those
 * who keep them; when changing a profile an empty one is left as it is, and
 * removing one is its own deliberate action.
 */
export function EmployeeEditorScreen({ employeeId }: { employeeId?: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const access = useHrAccess();
  const members = useMembers();
  const [hireDefault] = useState(today);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);

  const existing = useQuery({
    queryKey: keys.employee(employeeId ?? ''),
    queryFn: async () =>
      (
        await client.GET('/v1/hr/employees/{employeeId}', {
          params: { path: { employeeId: employeeId! } },
        })
      ).data!,
    enabled: employeeId !== undefined,
  });
  const initial = useMemo<Draft | null>(
    () =>
      employeeId === undefined
        ? blankDraft(hireDefault)
        : existing.data === undefined
          ? null
          : draftOf(existing.data),
    [employeeId, existing.data, hireDefault],
  );
  const values = draft ?? initial;
  const sensitive = access.sensitive;

  const create = values === null ? null : createBody(values, sensitive);
  const update =
    values === null || existing.data === undefined
      ? null
      : updateBody(values, existing.data, sensitive);
  const body = existing.data === undefined ? create : update;
  const idempotencyKey = useIdempotencyKey(body);
  const save = useMutation({
    mutationFn: async () =>
      employeeId === undefined
        ? (
            await client.POST('/v1/hr/employees', {
              params: { header: { 'Idempotency-Key': idempotencyKey } },
              body: create!,
            })
          ).data!
        : (
            await client.PATCH('/v1/hr/employees/{employeeId}', {
              params: { path: { employeeId } },
              body: update!,
            })
          ).data!,
    onSuccess: async (saved) => {
      queries.setQueryData(keys.employee(saved.id), saved);
      await queries.invalidateQueries({ queryKey: ['hr'] });
      navigate(paths.employee(saved.id));
    },
  });

  const back =
    employeeId === undefined ? (
      <BackLink to={paths.employees} label={t('hr.employee.back')} />
    ) : (
      <BackLink to={paths.employee(employeeId)} label={t('hr.editor.backToEmployee')} />
    );
  if (existing.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <HrFailure error={existing.error} onRetry={() => void existing.refetch()} />
      </div>
    );
  }
  if (!access.loaded || values === null) {
    return <Loading />;
  }
  if (!access.manage || existing.data?.can.edit === false) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Notice>
          <p>{t('hr.editor.cannotEdit')}</p>
        </Notice>
      </div>
    );
  }

  const set = (change: Partial<Draft>) => setDraft({ ...values, ...change });
  const setText = (field: PlainField | 'bankName' | 'fullName', value: string) => {
    const next = { ...values };
    next[field] = value;
    setDraft(next);
  };
  const setSecret = (field: SealedFieldName, value: SecretDraft) => {
    const next = { ...values };
    next[field] = value;
    setDraft(next);
  };
  const secretsValid = SEALED_FIELDS.every(
    (field) =>
      values[field].clear || values[field].value.trim() === '' || isSecret(values[field].value),
  );
  const ready =
    values.hireDate !== '' &&
    (values.link === 'member' ? values.userId !== '' : values.fullName.trim() !== '') &&
    (!sensitive || secretsValid);
  const memberOptions = (members.data ?? [])
    .filter((member) => member.status !== 'suspended' || member.userId === values.userId)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const title =
    existing.data === undefined
      ? t('hr.editor.newTitle')
      : t('hr.editor.editTitle', { name: existing.data.fullName });
  const text =
    (field: PlainField | 'bankName', options: { ltr?: boolean } = {}) =>
    (id: string, describedBy: string | undefined) => (
      <input
        id={id}
        dir={options.ltr === true ? 'ltr' : 'auto'}
        maxLength={field === 'phone' || field === 'emergencyContactPhone' ? 40 : 200}
        aria-describedby={describedBy}
        className={inputClass}
        value={values[field]}
        onChange={(event) => setText(field, event.target.value)}
      />
    );

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{title}</h1>
        <p className="text-sm text-content-muted">{t('hr.editor.intro')}</p>
      </header>

      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (ready) {
            save.mutate();
          }
        }}
      >
        <section className={cardClass} aria-labelledby="employee-who">
          <h2 id="employee-who" className="text-base font-semibold text-content">
            {t('hr.editor.who')}
          </h2>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">{t('hr.editor.who')}</legend>
            {(['member', 'standalone'] as const).map((link) => (
              <label key={link} className="flex items-center gap-2 text-sm text-content">
                <input
                  type="radio"
                  name="employee-link"
                  value={link}
                  checked={values.link === link}
                  onChange={() => set({ link })}
                />
                {link === 'member' ? t('hr.editor.linkMember') : t('hr.editor.linkStandalone')}
              </label>
            ))}
          </fieldset>
          {values.link === 'member' ? (
            <Field label={t('hr.editor.member')} hint={t('hr.editor.memberHint')}>
              {(id, describedBy) => (
                <select
                  id={id}
                  required
                  aria-describedby={describedBy}
                  aria-invalid={tried && values.userId === ''}
                  className={inputClass}
                  value={values.userId}
                  onChange={(event) => set({ userId: event.target.value })}
                >
                  <option value="">{t('hr.editor.chooseMember')}</option>
                  {memberOptions.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {`${member.displayName} — ${t(`workspace.role.${member.role}`)}`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <Field label={t('hr.field.fullName')}>
              {(id, describedBy) => (
                <input
                  id={id}
                  dir="auto"
                  required
                  maxLength={200}
                  aria-describedby={describedBy}
                  aria-invalid={tried && values.fullName.trim() === ''}
                  className={inputClass}
                  value={values.fullName}
                  onChange={(event) => set({ fullName: event.target.value })}
                />
              )}
            </Field>
          )}
        </section>

        <section className={cardClass} aria-labelledby="employee-job-edit">
          <h2 id="employee-job-edit" className="text-base font-semibold text-content">
            {t('hr.editor.job')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('hr.field.employeeNumber')}>
              {text('employeeNumber', { ltr: true })}
            </Field>
            <Field label={t('hr.field.hireDate')}>
              {(id, describedBy) => (
                <input
                  id={id}
                  type="date"
                  dir="ltr"
                  required
                  aria-describedby={describedBy}
                  aria-invalid={tried && values.hireDate === ''}
                  className={inputClass}
                  value={values.hireDate}
                  onChange={(event) => set({ hireDate: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('hr.field.jobTitle')}>{text('jobTitle')}</Field>
            <Field label={t('hr.field.department')}>{text('department')}</Field>
            <Field label={t('hr.field.phone')}>{text('phone', { ltr: true })}</Field>
          </div>
        </section>

        {sensitive ? (
          <section className={cardClass} aria-labelledby="employee-sensitive-edit">
            <div className="flex flex-col gap-1">
              <h2 id="employee-sensitive-edit" className="text-base font-semibold text-content">
                {t('hr.editor.sensitive')}
              </h2>
              <p className="text-sm text-content-muted">{t('hr.editor.sensitiveIntro')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {SEALED_FIELDS.map((field) => (
                <SecretInput
                  key={field}
                  field={field}
                  value={values[field]}
                  last4={existing.data?.sensitive?.[field]?.last4 ?? null}
                  tried={tried}
                  onChange={(next) => setSecret(field, next)}
                />
              ))}
              <Field label={t('hr.field.bankName')}>{text('bankName')}</Field>
            </div>
          </section>
        ) : null}

        <section className={cardClass} aria-labelledby="employee-emergency-edit">
          <h2 id="employee-emergency-edit" className="text-base font-semibold text-content">
            {t('hr.editor.emergency')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('hr.field.emergencyName')}>{text('emergencyContactName')}</Field>
            <Field label={t('hr.field.emergencyPhone')}>
              {text('emergencyContactPhone', { ltr: true })}
            </Field>
          </div>
        </section>

        {save.isError ? <HrFailure error={save.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass.primary} disabled={save.isPending}>
            {save.isPending
              ? t('hr.saving')
              : existing.data === undefined
                ? t('hr.editor.create')
                : t('hr.editor.saveChanges')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              navigate(employeeId === undefined ? paths.employees : paths.employee(employeeId))
            }
          >
            {t('hr.cancel')}
          </button>
        </div>
        {tried && !ready ? (
          <p role="alert" className="text-sm text-danger">
            {secretsValid ? t('hr.editor.notReady') : t('hr.editor.secretInvalid')}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/**
 * One sealed number. Typing replaces it; left empty it stays as it is; Clear
 * removes it on save, and says so, until undone.
 */
function SecretInput({
  field,
  value,
  last4,
  tried,
  onChange,
}: {
  field: SealedFieldName;
  value: SecretDraft;
  /** The last four of the number on record, when there is one. */
  last4: string | null;
  tried: boolean;
  onChange: (next: SecretDraft) => void;
}) {
  const { t } = useTranslation();
  const label = t(`hr.field.${field}`);
  const invalid = tried && !value.clear && value.value.trim() !== '' && !isSecret(value.value);
  const hint = value.clear
    ? t('hr.editor.willClear')
    : invalid
      ? t('hr.editor.secretInvalid')
      : last4 === null
        ? t('hr.editor.secretFormat')
        : t('hr.editor.keepHint', { last4 });
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <span className="flex gap-2">
          <input
            id={id}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            pattern={SECRET_PATTERN}
            disabled={value.clear}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            className={inputClass}
            value={value.value}
            onChange={(event) => onChange({ value: event.target.value, clear: false })}
          />
          {last4 === null ? null : value.clear ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => onChange({ value: '', clear: false })}
            >
              {t('hr.editor.undoClear')}
            </button>
          ) : (
            <button
              type="button"
              className={buttonClass.secondary}
              aria-label={t('hr.editor.clearLabel', { field: label })}
              onClick={() => onChange({ value: '', clear: true })}
            >
              {t('hr.editor.clear')}
            </button>
          )}
        </span>
      )}
    </Field>
  );
}
