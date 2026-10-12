import { PAY_METHODS, type PayMethod } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { keys, type PayTerms, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { useCompanyCurrency } from '../expenses/expense-parts.js';
import { Amount } from '../ledger/ledger-parts.js';
import { buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  formatQuantity,
  HOURS_PATTERN,
  isHours,
  isMoney,
  localToday,
  MONEY_PATTERN,
  PayrollFailure,
  usePayrollAccess,
} from './payroll-parts.js';

/**
 * An employee's pay, dated (ADR-0010): basic and allowances, whether they are
 * insured and on what wage, the month's standard hours and the overtime rate,
 * and how they are paid, each from a day on. Shown on the employee screen to
 * whoever keeps payroll when the company runs it; nobody else is sent asking.
 * Runs already prepared keep the figures they used.
 */
export function PayTermsSection({ employeeId }: { employeeId: string }) {
  const access = usePayrollAccess();
  if (!access.run) {
    return null;
  }
  return <PayTermsCard employeeId={employeeId} />;
}

function PayTermsCard({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const currency = useCompanyCurrency();
  const [editing, setEditing] = useState<{ terms: PayTerms | null } | null>(null);
  const [removing, setRemoving] = useState<PayTerms | null>(null);

  const terms = useQuery({
    queryKey: keys.payTerms(employeeId),
    queryFn: async () =>
      (
        await client.GET('/v1/hr/employees/{employeeId}/pay-terms', {
          params: { path: { employeeId } },
        })
      ).data!.items,
  });
  const done = async () => {
    setEditing(null);
    setRemoving(null);
    await queries.invalidateQueries({ queryKey: keys.payTerms(employeeId) });
  };

  const today = localToday();
  // Latest first: the first that has started is the one in force.
  const inForce = terms.data?.find((entry) => entry.effectiveFrom <= today);
  const money = (value: string) => <Amount value={value} currency={currency} />;

  return (
    <section aria-labelledby="employee-pay" className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="employee-pay" className="text-base font-semibold text-content">
            {t('payroll.terms.title')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.terms.intro')}</p>
        </div>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => setEditing({ terms: null })}
        >
          {t('payroll.terms.add')}
        </button>
      </div>

      {terms.isPending ? (
        <Loading />
      ) : terms.isError ? (
        <PayrollFailure error={terms.error} onRetry={() => void terms.refetch()} />
      ) : terms.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('payroll.terms.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {terms.data.map((entry) => {
            const from = formatCalendarDate(entry.effectiveFrom, { locale });
            return (
              <li key={entry.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-content">
                    <span>{t('payroll.terms.from', { date: from })}</span>
                    {entry.id === inForce?.id ? (
                      <span className="inline-flex items-center rounded-full border border-success bg-success-subtle px-2 py-0.5 text-xs font-medium">
                        {t('payroll.terms.inForce')}
                      </span>
                    ) : entry.effectiveFrom > today ? (
                      <span className="inline-flex items-center rounded-full border border-accent px-2 py-0.5 text-xs font-medium">
                        {t('payroll.terms.upcoming')}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      aria-label={t('payroll.terms.editLabel', { date: from })}
                      onClick={() => setEditing({ terms: entry })}
                    >
                      {t('payroll.terms.edit')}
                    </button>
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      aria-label={t('payroll.terms.removeLabel', { date: from })}
                      onClick={() => setRemoving(entry)}
                    >
                      {t('payroll.terms.remove')}
                    </button>
                  </div>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <Term label={t('payroll.terms.basic')}>{money(entry.basic)}</Term>
                  <Term label={t('payroll.terms.allowances')}>{money(entry.allowances)}</Term>
                  <Term label={t('payroll.terms.insurance')}>
                    {!entry.insured
                      ? t('payroll.terms.notInsured')
                      : entry.insurableWage === null
                        ? t('payroll.terms.insuredOnPay')
                        : t('payroll.terms.insuredOn', {
                            wage: formatAmount(entry.insurableWage, currency, locale),
                          })}
                  </Term>
                  <Term label={t('payroll.terms.standardHours')}>
                    {formatQuantity(entry.standardHours, locale)}
                  </Term>
                  <Term label={t('payroll.terms.overtimeRate')}>
                    {entry.overtimeRate === null
                      ? t('payroll.terms.overtimeDefault')
                      : money(entry.overtimeRate)}
                  </Term>
                  <Term label={t('payroll.terms.payMethod')}>
                    {t(`payroll.payMethod.${entry.payMethod}`)}
                  </Term>
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {editing === null ? null : (
        <TermsDialog
          employeeId={employeeId}
          terms={editing.terms}
          onClose={() => setEditing(null)}
          onDone={done}
        />
      )}
      {removing === null ? null : (
        <RemoveTermsDialog terms={removing} onClose={() => setRemoving(null)} onDone={done} />
      )}
    </section>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </div>
  );
}

interface TermsForm {
  effectiveFrom: string;
  basic: string;
  allowances: string;
  insured: boolean;
  insurableWage: string;
  standardHours: string;
  overtimeRate: string;
  payMethod: PayMethod;
}

/** Adds terms from a date, or corrects terms already entered. */
function TermsDialog({
  employeeId,
  terms,
  onClose,
  onDone,
}: {
  employeeId: string;
  terms: PayTerms | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [form, setForm] = useState<TermsForm>(() =>
    terms === null
      ? {
          effectiveFrom: `${localToday().slice(0, 7)}-01`,
          basic: '',
          allowances: '0',
          insured: true,
          insurableWage: '',
          standardHours: '208',
          overtimeRate: '',
          payMethod: 'bank_transfer',
        }
      : {
          effectiveFrom: terms.effectiveFrom,
          basic: terms.basic,
          allowances: terms.allowances,
          insured: terms.insured,
          insurableWage: terms.insurableWage ?? '',
          standardHours: terms.standardHours,
          overtimeRate: terms.overtimeRate ?? '',
          payMethod: terms.payMethod,
        },
  );
  const [tried, setTried] = useState(false);
  const set = (change: Partial<TermsForm>) => setForm({ ...form, ...change });

  const problems = {
    effectiveFrom: !/^\d{4}-\d{2}-\d{2}$/u.test(form.effectiveFrom),
    basic: !isMoney(form.basic),
    allowances: !isMoney(form.allowances),
    insurableWage: form.insured && form.insurableWage.trim() !== '' && !isMoney(form.insurableWage),
    standardHours: !isHours(form.standardHours),
    overtimeRate: form.overtimeRate.trim() !== '' && !isMoney(form.overtimeRate),
  };
  const invalid = Object.values(problems).some(Boolean);
  const shown = (field: keyof typeof problems) => tried && problems[field];

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        effectiveFrom: form.effectiveFrom,
        basic: form.basic.trim(),
        allowances: form.allowances.trim(),
        insured: form.insured,
        insurableWage:
          !form.insured || form.insurableWage.trim() === '' ? null : form.insurableWage.trim(),
        standardHours: form.standardHours.trim(),
        overtimeRate: form.overtimeRate.trim() === '' ? null : form.overtimeRate.trim(),
        payMethod: form.payMethod,
      };
      if (terms === null) {
        await client.POST('/v1/hr/employees/{employeeId}/pay-terms', {
          params: {
            path: { employeeId },
            header: { 'Idempotency-Key': crypto.randomUUID() },
          },
          body,
        });
      } else {
        await client.PATCH('/v1/payroll/pay-terms/{termsId}', {
          params: { path: { termsId: terms.id } },
          body: { ...body, expectedVersion: terms.version },
        });
      }
    },
    onSuccess: onDone,
  });

  const amountField = (
    field: 'basic' | 'allowances' | 'insurableWage' | 'overtimeRate',
    label: string,
    hint: string,
  ) => (
    <Field label={label} hint={shown(field) ? t('payroll.terms.amountInvalid') : hint}>
      {(id, describedBy) => (
        <input
          id={id}
          type="text"
          inputMode="decimal"
          dir="ltr"
          pattern={MONEY_PATTERN}
          aria-describedby={describedBy}
          aria-invalid={shown(field)}
          className={inputClass}
          value={form[field]}
          onChange={(event) => set({ [field]: event.target.value })}
        />
      )}
    </Field>
  );

  return (
    <Dialog
      wide
      title={terms === null ? t('payroll.terms.addTitle') : t('payroll.terms.editTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="submit"
            form="payroll-terms"
            className={buttonClass.primary}
            disabled={save.isPending}
          >
            {save.isPending ? t('payroll.saving') : t('payroll.save')}
          </button>
        </>
      }
    >
      <form
        id="payroll-terms"
        className="grid gap-3 sm:grid-cols-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!invalid) {
            save.mutate();
          }
        }}
      >
        <Field
          label={t('payroll.terms.effectiveFrom')}
          hint={t('payroll.terms.effectiveHint')}
          className="sm:col-span-2"
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              required
              aria-describedby={describedBy}
              aria-invalid={shown('effectiveFrom')}
              className={inputClass}
              value={form.effectiveFrom}
              onChange={(event) => set({ effectiveFrom: event.target.value })}
            />
          )}
        </Field>
        {amountField('basic', t('payroll.terms.basic'), t('payroll.terms.basicHint'))}
        {amountField(
          'allowances',
          t('payroll.terms.allowances'),
          t('payroll.terms.allowancesHint'),
        )}
        <div className="flex items-center gap-2 sm:col-span-2">
          <input
            id="payroll-terms-insured"
            type="checkbox"
            className="size-4"
            checked={form.insured}
            onChange={(event) => set({ insured: event.target.checked })}
          />
          <label htmlFor="payroll-terms-insured" className="text-sm text-content">
            {t('payroll.terms.insured')}
          </label>
        </div>
        {form.insured
          ? amountField(
              'insurableWage',
              t('payroll.terms.insurableWage'),
              t('payroll.terms.insurableWageHint'),
            )
          : null}
        <Field
          label={t('payroll.terms.standardHours')}
          hint={
            shown('standardHours')
              ? t('payroll.terms.hoursInvalid')
              : t('payroll.terms.standardHoursHint')
          }
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="text"
              inputMode="decimal"
              dir="ltr"
              pattern={HOURS_PATTERN}
              aria-describedby={describedBy}
              aria-invalid={shown('standardHours')}
              className={inputClass}
              value={form.standardHours}
              onChange={(event) => set({ standardHours: event.target.value })}
            />
          )}
        </Field>
        {amountField(
          'overtimeRate',
          t('payroll.terms.overtimeRate'),
          t('payroll.terms.overtimeRateHint'),
        )}
        <Field label={t('payroll.terms.payMethod')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={form.payMethod}
              onChange={(event) => set({ payMethod: event.target.value as PayMethod })}
            >
              {PAY_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`payroll.payMethod.${method}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {save.isError ? (
          <div className="sm:col-span-2">
            <PayrollFailure error={save.error} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function RemoveTermsDialog({
  terms,
  onClose,
  onDone,
}: {
  terms: PayTerms;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const remove = useMutation({
    mutationFn: async () => {
      await client.DELETE('/v1/payroll/pay-terms/{termsId}', {
        params: { path: { termsId: terms.id } },
      });
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('payroll.terms.removeTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? t('payroll.terms.removing') : t('payroll.terms.remove')}
          </button>
        </>
      }
    >
      <p>
        {t('payroll.terms.removeIntro', {
          date: formatCalendarDate(terms.effectiveFrom, { locale }),
        })}
      </p>
      {remove.isError ? <PayrollFailure error={remove.error} /> : null}
    </Dialog>
  );
}
