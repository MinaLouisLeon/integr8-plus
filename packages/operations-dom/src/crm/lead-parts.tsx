import { LEAD_SOURCES, OPEN_LEAD_STATUSES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import {
  keys,
  type Lead,
  type LeadSource,
  type LeadStatus,
  type Member,
  useOperations,
} from '../api.js';
import { Field, inputClass } from '../ui.js';

/**
 * The pieces the lead screens share (CRM/ERP plan, phase C1): a status badge,
 * a money formatter that never turns an amount into a float, the company's
 * members for assigning, and the lead form's fields.
 */

const STATUS_STYLE: Record<LeadStatus, string> = {
  new: 'border-accent bg-surface text-content',
  contacted: 'border-border-subtle bg-surface-muted text-content',
  qualified: 'border-success bg-success-subtle text-content',
  unqualified: 'border-border-subtle bg-surface-muted text-content-muted',
  converted: 'border-success bg-success text-on-accent',
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {t(`crm.status.${status}`)}
    </span>
  );
}

/**
 * An amount and its currency, in the reader's locale.
 *
 * The amount arrives as a decimal string and goes to `Intl.NumberFormat` as
 * one: since ES2023 it formats a numeric string exactly, so nothing on the way
 * passes through a JavaScript number and loses a digit.
 */
export function formatAmount(value: string, currency: string | null, locale: string): string {
  const format = (amount: string, options: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(amount as unknown as number);
  try {
    return currency === null
      ? format(value, { maximumFractionDigits: 4 })
      : format(value, { style: 'currency', currency, maximumFractionDigits: 4 });
  } catch {
    return currency === null ? value : `${value} ${currency}`;
  }
}

/** The company's members, for assigning and for showing who something is assigned to. */
export function useMembers() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.members,
    queryFn: async () =>
      (await client.GET('/v1/members', { params: { query: { limit: 200 } } })).data!.items,
  });
}

/** A member's name, or nothing when the id is not (or no longer) one of them. */
export function memberName(
  members: readonly Member[] | undefined,
  userId: string | null,
): string | null {
  if (userId === null) {
    return null;
  }
  return members?.find((member) => member.userId === userId)?.displayName ?? null;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface LeadDraft {
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  source: LeadSource;
  status: Exclude<LeadStatus, 'converted'>;
  assignedTo: string;
  estimatedValue: string;
  currencyCode: string;
  notes: string;
  unqualifiedReason: string;
}

export const emptyLead: LeadDraft = {
  displayName: '',
  companyName: '',
  email: '',
  phone: '',
  source: 'manual',
  status: 'new',
  assignedTo: '',
  estimatedValue: '',
  currencyCode: '',
  notes: '',
  unqualifiedReason: '',
};

export function leadDraft(lead: Lead): LeadDraft {
  return {
    displayName: lead.displayName,
    companyName: lead.companyName ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    source: lead.source,
    status: lead.status === 'converted' ? 'qualified' : lead.status,
    assignedTo: lead.assignedTo ?? '',
    estimatedValue: lead.estimatedValue ?? '',
    currencyCode: lead.currencyCode ?? '',
    notes: lead.notes ?? '',
    unqualifiedReason: lead.unqualifiedReason ?? '',
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** The request body for a new lead. Empty fields are left out or sent as null, never as "". */
export function toLeadBody(draft: LeadDraft) {
  return {
    displayName: draft.displayName.trim(),
    companyName: orNull(draft.companyName),
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    source: draft.source,
    status: draft.status,
    assignedTo: orNull(draft.assignedTo),
    estimatedValue: orNull(draft.estimatedValue),
    currencyCode: orNull(draft.currencyCode)?.toUpperCase() ?? null,
    notes: orNull(draft.notes),
    unqualifiedReason: draft.status === 'unqualified' ? orNull(draft.unqualifiedReason) : null,
  };
}

/** Only what changed between two drafts, so an edit never overwrites a field it did not touch. */
export function changedLeadFields(before: LeadDraft, after: LeadDraft) {
  const a = toLeadBody(before);
  const b = toLeadBody(after);
  return Object.fromEntries(
    (Object.keys(b) as (keyof typeof b)[])
      .filter((key) => a[key] !== b[key])
      .map((key) => [key, b[key]]),
  ) as Partial<ReturnType<typeof toLeadBody>>;
}

export function LeadFields({
  draft,
  onChange,
  members,
}: {
  draft: LeadDraft;
  onChange: (draft: LeadDraft) => void;
  members: readonly Member[];
}) {
  const { t } = useTranslation();
  const set = <K extends keyof LeadDraft>(key: K, value: LeadDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const assignable = members.filter(
    (member) => member.status === 'active' || member.userId === draft.assignedTo,
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('crm.leads.fields.displayName')} className="sm:col-span-2">
        {(id) => (
          <input
            id={id}
            className={inputClass}
            required
            maxLength={200}
            value={draft.displayName}
            onChange={(event) => set('displayName', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('crm.leads.fields.company')}>
        {(id) => (
          <input
            id={id}
            className={inputClass}
            maxLength={200}
            value={draft.companyName}
            onChange={(event) => set('companyName', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('crm.leads.fields.email')}>
        {(id) => (
          <input
            id={id}
            type="email"
            dir="ltr"
            className={inputClass}
            maxLength={320}
            value={draft.email}
            onChange={(event) => set('email', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('crm.leads.fields.phone')}>
        {(id) => (
          <input
            id={id}
            type="tel"
            dir="ltr"
            className={inputClass}
            maxLength={50}
            value={draft.phone}
            onChange={(event) => set('phone', event.target.value)}
          />
        )}
      </Field>
      <Field label={t('crm.leads.fields.source')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.source}
            onChange={(event) => set('source', event.target.value as LeadSource)}
          >
            {LEAD_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`crm.source.${source}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('crm.leads.fields.status')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.status}
            onChange={(event) => set('status', event.target.value as LeadDraft['status'])}
          >
            {OPEN_LEAD_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`crm.status.${status}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('crm.leads.fields.assignee')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={draft.assignedTo}
            onChange={(event) => set('assignedTo', event.target.value)}
          >
            <option value="">{t('crm.leads.unassigned')}</option>
            {assignable.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('crm.leads.fields.value')} hint={t('crm.leads.valueHint')}>
        {(id, describedBy) => (
          <input
            id={id}
            inputMode="decimal"
            dir="ltr"
            className={inputClass}
            aria-describedby={describedBy}
            pattern="\d{1,16}(\.\d{1,4})?"
            value={draft.estimatedValue}
            onChange={(event) => set('estimatedValue', event.target.value.trim())}
          />
        )}
      </Field>
      <Field label={t('crm.leads.fields.currency')} hint={t('crm.leads.currencyHint')}>
        {(id, describedBy) => (
          <input
            id={id}
            dir="ltr"
            className={inputClass}
            aria-describedby={describedBy}
            maxLength={3}
            pattern="[A-Za-z]{3}"
            value={draft.currencyCode}
            onChange={(event) => set('currencyCode', event.target.value.toUpperCase())}
          />
        )}
      </Field>
      {draft.status === 'unqualified' ? (
        <Field label={t('crm.leads.fields.unqualifiedReason')} className="sm:col-span-2">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              maxLength={1000}
              value={draft.unqualifiedReason}
              onChange={(event) => set('unqualifiedReason', event.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('crm.leads.fields.notes')} className="sm:col-span-2">
        {(id) => (
          <textarea
            id={id}
            rows={4}
            className={inputClass}
            maxLength={10_000}
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
          />
        )}
      </Field>
    </div>
  );
}
