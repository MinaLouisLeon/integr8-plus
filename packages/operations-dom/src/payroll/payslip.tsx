import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useId } from 'react';
import type { Payslip } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { formatMonth, isZero } from '../ledger/ledger-parts.js';
import { buttonClass, inputClass } from '../ui.js';
import {
  disclaimerText,
  formatQuantity,
  PAYSLIP_LANGUAGES,
  type PayslipLanguage,
} from './payroll-parts.js';

/**
 * A payslip as a document (ADR-0010): what the office prints for each
 * employee, and what each employee prints for themselves. The month, the
 * employee, what was earned and taken off, the net pay, the employer's share
 * of social insurance for information, and the disclaimer. In English or in
 * Arabic, right to left, whatever language the screen is in; one to a page
 * when several are printed together.
 */
export function PayslipDocument({
  payslip,
  language,
  company,
}: {
  payslip: Payslip;
  language: PayslipLanguage;
  /** The company's name, for a payslip from a server that sends no issuer block. */
  company?: string | null;
}) {
  const { i18n } = useTranslation();
  const t = i18n.getFixedT(language);
  const titleId = useId();
  const { run, employee, line } = payslip;
  const locale = language;
  const money = (value: string) => formatAmount(value, run.currency, locale);
  const date = (value: string) => formatCalendarDate(value, { locale });
  const month = formatMonth(run.periodStart, locale);
  // Who pays, as the invoices print it: the legal name, address and tax number.
  const issuer = (payslip as Partial<Payslip>).company ?? {
    name: company ?? '',
    address: null,
    taxReference: null,
  };

  // Each entry: its label, the amount, a line of detail, and whether it shows when nothing.
  type Entry = [label: string, value: string, detail: string | null, always: boolean];
  const earnings: Entry[] = [
    [t('payroll.payslip.basic'), line.basic, null, true],
    [t('payroll.payslip.allowances'), line.allowances, null, true],
    [
      t('payroll.payslip.overtime'),
      line.overtimePay,
      t('payroll.payslip.overtimeDetail', {
        hours: formatQuantity(line.overtimeHours, locale),
        rate: money(line.overtimeRate),
      }),
      false,
    ],
    [t('payroll.payslip.bonus'), line.bonus, null, false],
  ];
  const lessBeforeTax: Entry[] = [
    [t('payroll.payslip.deduction'), line.deduction, null, false],
    [
      t('payroll.payslip.unpaidLeave'),
      line.unpaidLeave,
      t('payroll.payslip.unpaidDetail', { days: formatQuantity(line.unpaidDays, locale) }),
      false,
    ],
  ];
  const deductions: Entry[] = [
    [
      t('payroll.payslip.socialInsurance'),
      line.socialInsuranceEmployee,
      line.insured
        ? t('payroll.payslip.insurableDetail', { wage: money(line.insurableWage) })
        : t('payroll.payslip.notInsured'),
      true,
    ],
    [t('payroll.payslip.incomeTax'), line.incomeTax, null, true],
    [t('payroll.payslip.martyrsFund'), line.martyrsFund, null, true],
  ];

  const rows = (entries: Entry[], sign: '' | '−' = '') =>
    entries
      .filter(([, value, , always]) => always || !isZero(value))
      .map(([label, value, detail]) => (
        <tr key={label} className="border-b border-neutral-200">
          <th scope="row" className="py-1.5 text-start font-normal">
            <span>{label}</span>
            {detail === null ? null : (
              <span className="block text-xs text-neutral-600">{detail}</span>
            )}
          </th>
          <td className="py-1.5 text-end tabular-nums whitespace-nowrap">
            {sign === '' || isZero(value) ? money(value) : `${sign} ${money(value)}`}
          </td>
        </tr>
      ));

  return (
    <article
      lang={language}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      aria-labelledby={titleId}
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-lg border border-neutral-300 bg-white p-8 text-start text-sm text-black print:max-w-none print:rounded-none print:border-0 print:p-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          {issuer.name === '' ? null : (
            <p className="text-lg font-semibold" dir="auto">
              {issuer.name}
            </p>
          )}
          {issuer.address === null ? null : (
            <p className="text-xs whitespace-pre-line text-neutral-700" dir="auto">
              {issuer.address}
            </p>
          )}
          {issuer.taxReference === null ? null : (
            <p className="text-xs text-neutral-700">
              <span>{t('payroll.payslip.taxReference')}: </span>
              <span dir="ltr">{issuer.taxReference}</span>
            </p>
          )}
          <h2 id={titleId} className="text-xl font-semibold">
            {t('payroll.payslip.title', { month })}
          </h2>
        </div>
        <dl className="flex flex-col gap-0.5 text-end">
          <div>
            <dt className="inline text-neutral-600">{t('payroll.payslip.reference')}: </dt>
            <dd className="inline" dir="ltr">
              {run.reference}
            </dd>
          </div>
          <div>
            <dt className="inline text-neutral-600">{t('payroll.payslip.period')}: </dt>
            <dd className="inline">
              {t('payroll.payslip.periodRange', {
                from: date(run.periodStart),
                to: date(run.periodEnd),
              })}
            </dd>
          </div>
          <div>
            <dt className="inline text-neutral-600">{t('payroll.payslip.payDate')}: </dt>
            <dd className="inline">
              {run.payDate === null ? t('payroll.payslip.noPayDate') : date(run.payDate)}
            </dd>
          </div>
        </dl>
      </header>

      <section className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <p>
          <span className="text-neutral-600">{t('payroll.payslip.employee')}: </span>
          <span className="font-medium" dir="auto">
            {employee.name}
          </span>
        </p>
        {employee.employeeNumber === null ? null : (
          <p>
            <span className="text-neutral-600">{t('payroll.payslip.employeeNumber')}: </span>
            <span dir="ltr">{employee.employeeNumber}</span>
          </p>
        )}
        {employee.jobTitle === null ? null : (
          <p>
            <span className="text-neutral-600">{t('payroll.payslip.jobTitle')}: </span>
            <span dir="auto">{employee.jobTitle}</span>
          </p>
        )}
        {employee.department === null ? null : (
          <p>
            <span className="text-neutral-600">{t('payroll.payslip.department')}: </span>
            <span dir="auto">{employee.department}</span>
          </p>
        )}
        <p>
          <span className="text-neutral-600">{t('payroll.payslip.hireDate')}: </span>
          {date(employee.hireDate)}
        </p>
        <p>
          <span className="text-neutral-600">{t('payroll.payslip.payMethod')}: </span>
          {t(`payroll.payMethod.${line.payMethod}`)}
        </p>
      </section>

      <table className="w-full">
        <caption className="sr-only">{t('payroll.payslip.breakdown')}</caption>
        <tbody>
          <tr>
            <th
              scope="rowgroup"
              colSpan={2}
              className="border-b border-black pb-1 pt-2 text-start text-xs font-semibold uppercase tracking-wide"
            >
              {t('payroll.payslip.earnings')}
            </th>
          </tr>
          {rows(earnings)}
          {rows(lessBeforeTax, '−')}
          <tr className="border-b border-black font-semibold">
            <th scope="row" className="py-1.5 text-start">
              {t('payroll.payslip.gross')}
            </th>
            <td className="py-1.5 text-end tabular-nums whitespace-nowrap">{money(line.gross)}</td>
          </tr>
          <tr>
            <th
              scope="rowgroup"
              colSpan={2}
              className="border-b border-black pb-1 pt-4 text-start text-xs font-semibold uppercase tracking-wide"
            >
              {t('payroll.payslip.deductions')}
            </th>
          </tr>
          {rows(deductions, '−')}
          {isZero(line.reimbursements) ? null : (
            <tr className="border-b border-neutral-200">
              <th scope="row" className="py-1.5 text-start font-normal">
                <span>{t('payroll.payslip.reimbursements')}</span>
                <span className="block text-xs text-neutral-600">
                  {t('payroll.payslip.reimbursementsDetail')}
                </span>
              </th>
              <td className="py-1.5 text-end tabular-nums whitespace-nowrap">
                + {money(line.reimbursements)}
              </td>
            </tr>
          )}
          <tr className="text-base font-semibold">
            <th scope="row" className="border-t-2 border-black py-2 text-start">
              {t('payroll.payslip.net')}
            </th>
            <td className="border-t-2 border-black py-2 text-end tabular-nums whitespace-nowrap">
              {money(line.net)}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="text-xs text-neutral-700">
        {t('payroll.payslip.employerShare', { amount: money(line.socialInsuranceEmployer) })}
      </p>
      {line.note === null ? null : (
        <p className="text-xs" dir="auto">
          <span className="text-neutral-600">{t('payroll.payslip.note')}: </span>
          {line.note}
        </p>
      )}
      <footer className="border-t border-neutral-300 pt-3 text-xs text-neutral-700">
        {disclaimerText(payslip.disclaimer, language, t('payroll.disclaimer'))}
      </footer>
    </article>
  );
}

/** Which language payslips are printed in, offered beside a print button. */
export function PayslipLanguagePicker({
  value,
  onChange,
}: {
  value: PayslipLanguage;
  onChange: (next: PayslipLanguage) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {t('payroll.payslip.language')}
      </label>
      <select
        id={id}
        className={`${inputClass} w-auto`}
        value={value}
        onChange={(event) => onChange(event.target.value as PayslipLanguage)}
      >
        {PAYSLIP_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(`payroll.payslip.languages.${language}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Several payslips, one to a printed page. */
export function PayslipStack({
  payslips,
  language,
  company,
}: {
  payslips: readonly Payslip[];
  language: PayslipLanguage;
  company?: string | null;
}) {
  return (
    <div className="flex flex-col gap-6 print:block">
      {payslips.map((payslip) => (
        <div
          key={`${payslip.run.id}-${payslip.line.id}`}
          className="print:break-after-page print:last:break-after-auto"
        >
          <PayslipDocument
            payslip={payslip}
            language={language}
            {...(company === undefined ? {} : { company })}
          />
        </div>
      ))}
    </div>
  );
}

/** The print button: the browser prints what is on screen, without the screen's controls. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className={buttonClass.primary} onClick={() => window.print()}>
      {label}
    </button>
  );
}
