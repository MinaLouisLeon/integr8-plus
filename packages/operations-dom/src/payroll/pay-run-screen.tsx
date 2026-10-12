import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { keys, type PayLine, type PayRunDetail, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { Fact } from '../hr/hr-parts.js';
import { Amount, AppLink, formatMonth } from '../ledger/ledger-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  DAYS_PATTERN,
  Disclaimer,
  disclaimerText,
  errorCode,
  formatQuantity,
  HOURS_PATTERN,
  isDays,
  isHours,
  isMoney,
  languageOf,
  MONEY_PATTERN,
  Notice,
  PayrollFailure,
  RunStatusBadge,
  usePayrollAccess,
} from './payroll-parts.js';
import { PayslipLanguagePicker, PayslipStack, PrintButton } from './payslip.js';

type DialogKind = 'details' | 'approve' | 'discard';

/**
 * One month's pay run (ADR-0010). The disclaimer first; then the totals and
 * every employee's line — what they earn, what is taken off and what they are
 * paid, with the employer's share of insurance beside it. While a draft, the
 * person preparing it types each line's overtime, bonus, deduction and unpaid
 * days, recalculates it from today's terms, hours and claims, sets the pay
 * date, or discards it; somebody else approves it. An approved run prints
 * its payslips and gives the insurance report and the bank file.
 */
export function PayRunScreen({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale, navigate, download } = useOperations();
  const queries = useQueryClient();
  const access = usePayrollAccess();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<'run' | 'payslips'>('run');
  const approveNoteId = useId();

  const detail = useQuery({
    queryKey: keys.payRun(runId),
    queryFn: async () =>
      (await client.GET('/v1/payroll/runs/{runId}', { params: { path: { runId } } })).data!,
  });
  const settle = async (next: PayRunDetail) => {
    setDialog(null);
    setEditing(null);
    queries.setQueryData(keys.payRun(next.id), next);
    await queries.invalidateQueries({ queryKey: keys.payRuns });
  };

  const recalculate = useMutation({
    mutationFn: async (version: number) =>
      (
        await client.POST('/v1/payroll/runs/{runId}/recalculate', {
          params: { path: { runId } },
          body: { expectedVersion: version },
        })
      ).data!,
    onSuccess: settle,
  });

  const exportFile = useMutation({
    mutationFn: async ({ kind, reference }: { kind: 'insurance' | 'bank'; reference: string }) => {
      const options = { params: { path: { runId } }, parseAs: 'blob' as const };
      const { data } =
        kind === 'insurance'
          ? await client.GET('/v1/payroll/runs/{runId}/insurance.csv', options)
          : await client.GET('/v1/payroll/runs/{runId}/bank.csv', options);
      download(data as unknown as Blob, `${reference}-${kind}.csv`);
    },
  });

  const back = (
    <div className="print:hidden">
      <BackLink to={paths.payRuns} label={t('payroll.run.back')} />
    </div>
  );
  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <PayrollFailure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const run = detail.data;
  const month = formatMonth(run.periodStart, locale);
  const draft = run.status === 'draft';
  const date = (value: string) => formatCalendarDate(value, { locale });

  if (view === 'payslips') {
    return <RunPayslips run={run} month={month} onBack={() => setView('run')} />;
  }

  // Why approving is not offered, said beside the disabled button.
  const approveNote = !draft
    ? null
    : !access.approve
      ? t('payroll.approve.notApprover')
      : run.can.approve
        ? null
        : run.preparedBy.id === access.userId
          ? t('payroll.approve.youPrepared')
          : run.lines.length === 0
            ? t('payroll.approve.empty')
            : t('payroll.approve.notNow');
  const busy = recalculate.isPending;

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span>{t('payroll.run.title', { month })}</span>
            <RunStatusBadge status={run.status} />
          </h1>
          <p className="text-sm text-content-muted" dir="ltr">
            {run.reference}
          </p>
        </div>
        {draft ? (
          <div className="flex flex-wrap items-start gap-2">
            {run.can.edit ? (
              <>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={() => recalculate.mutate(run.version)}
                >
                  {busy ? t('payroll.run.recalculating') : t('payroll.run.recalculate')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('details')}
                >
                  {t('payroll.run.editDetails')}
                </button>
              </>
            ) : null}
            {run.can.discard ? (
              <button
                type="button"
                className={buttonClass.danger}
                onClick={() => setDialog('discard')}
              >
                {t('payroll.discard.action')}
              </button>
            ) : null}
            {access.approve ? (
              <button
                type="button"
                className={buttonClass.primary}
                disabled={!run.can.approve}
                aria-describedby={approveNote === null ? undefined : approveNoteId}
                onClick={() => setDialog('approve')}
              >
                {t('payroll.approve.action')}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {approveNote === null ? null : (
        <p id={approveNoteId} className="text-sm text-content-muted">
          {approveNote}
        </p>
      )}

      <Disclaimer text={disclaimerText(run.disclaimer, locale, t('payroll.disclaimer'))} />

      {recalculate.isError ? <PayrollFailure error={recalculate.error} /> : null}

      <section aria-labelledby="run-about" className={cardClass}>
        <h2 id="run-about" className="text-base font-semibold text-content">
          {t('payroll.run.about')}
        </h2>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('payroll.run.period')}>
            {t('payroll.payslip.periodRange', {
              from: date(run.periodStart),
              to: date(run.periodEnd),
            })}
          </Fact>
          <Fact label={t('payroll.run.ruleSet')}>
            <AppLink to={paths.payrollRules}>
              <span dir="auto">{run.ruleSet.name}</span>
            </AppLink>
          </Fact>
          <Fact label={t('payroll.run.payDate')}>
            {run.payDate === null ? (
              <span className="text-content-muted">{t('payroll.run.noPayDate')}</span>
            ) : (
              date(run.payDate)
            )}
          </Fact>
          <Fact label={t('payroll.run.prepared')}>
            {t('payroll.run.byAt', {
              name: run.preparedBy.name,
              when: formatDateTime(run.preparedAt, { locale }),
            })}
          </Fact>
          <Fact label={t('payroll.run.approved')}>
            {run.approvedBy === null || run.approvedAt === null ? (
              <span className="text-content-muted">{t('payroll.run.notApproved')}</span>
            ) : (
              t('payroll.run.byAt', {
                name: run.approvedBy.name,
                when: formatDateTime(run.approvedAt, { locale }),
              })
            )}
          </Fact>
          {run.note === null ? null : (
            <Fact label={t('payroll.run.note')} wide>
              <span dir="auto" className="whitespace-pre-line">
                {run.note}
              </span>
            </Fact>
          )}
        </dl>
      </section>

      {run.withoutTerms.length === 0 ? null : (
        <section
          aria-labelledby="run-without-terms"
          className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-subtle p-4 text-sm text-content"
        >
          <h2 id="run-without-terms" className="font-semibold">
            {t('payroll.run.withoutTermsTitle', { count: run.withoutTerms.length })}
          </h2>
          <p>{t('payroll.run.withoutTermsIntro')}</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {run.withoutTerms.map((employee) => (
              <li key={employee.id}>
                <AppLink to={paths.employee(employee.id)}>
                  <span dir="auto">{employee.name}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Totals run={run} />

      {!draft ? (
        <Outputs
          run={run}
          sensitive={access.sensitive}
          pending={exportFile.isPending}
          error={exportFile.error}
          onPayslips={() => setView('payslips')}
          onExport={(kind) => exportFile.mutate({ kind, reference: run.reference })}
        />
      ) : access.sensitive ? (
        <section aria-labelledby="run-check" className={cardClass}>
          <h2 id="run-check" className="text-base font-semibold text-content">
            {t('payroll.outputs.checkTitle')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.outputs.checkIntro')}</p>
          <div>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={exportFile.isPending}
              onClick={() => exportFile.mutate({ kind: 'insurance', reference: run.reference })}
            >
              {t('payroll.outputs.insurance')}
            </button>
          </div>
          {exportFile.isError ? <PayrollFailure error={exportFile.error} /> : null}
        </section>
      ) : null}

      <Lines run={run} editing={editing} onEdit={setEditing} onSaved={settle} />

      {dialog === 'details' ? (
        <DetailsDialog run={run} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'approve' ? (
        <ApproveDialog run={run} month={month} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'discard' ? (
        <DiscardDialog
          run={run}
          month={month}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            queries.removeQueries({ queryKey: keys.payRun(run.id) });
            await queries.invalidateQueries({ queryKey: keys.payRuns });
            navigate(paths.payRuns);
          }}
        />
      ) : null}
    </div>
  );
}

/** The run's totals, as the server added them up. */
function Totals({ run }: { run: PayRunDetail }) {
  const { t } = useTranslation();
  const money = (value: string, strong = false) => (
    <Amount value={value} currency={run.currency} strong={strong} />
  );
  const { totals } = run;
  return (
    <section aria-labelledby="run-totals" className={cardClass}>
      <h2 id="run-totals" className="text-base font-semibold text-content">
        {t('payroll.totals.title')}
      </h2>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label={t('payroll.totals.employees')}>
          <span className="tabular-nums">{totals.employees}</span>
        </Fact>
        <Fact label={t('payroll.totals.gross')}>{money(totals.gross)}</Fact>
        <Fact label={t('payroll.totals.siEmployee')}>{money(totals.socialInsuranceEmployee)}</Fact>
        <Fact label={t('payroll.totals.incomeTax')}>{money(totals.incomeTax)}</Fact>
        <Fact label={t('payroll.totals.martyrsFund')}>{money(totals.martyrsFund)}</Fact>
        <Fact label={t('payroll.totals.reimbursements')}>{money(totals.reimbursements)}</Fact>
        <Fact label={t('payroll.totals.net')}>{money(totals.net, true)}</Fact>
        <Fact label={t('payroll.totals.siEmployer')}>{money(totals.socialInsuranceEmployer)}</Fact>
      </dl>
    </section>
  );
}

/** What an approved run gives: payslips to print, the insurance report and the bank file. */
function Outputs({
  run,
  sensitive,
  pending,
  error,
  onPayslips,
  onExport,
}: {
  run: PayRunDetail;
  sensitive: boolean;
  pending: boolean;
  error: unknown;
  onPayslips: () => void;
  onExport: (kind: 'insurance' | 'bank') => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="run-outputs" className={cardClass}>
      <h2 id="run-outputs" className="text-base font-semibold text-content">
        {t('payroll.outputs.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass.primary} onClick={onPayslips}>
          {t('payroll.outputs.payslips')}
        </button>
        {sensitive ? (
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={pending}
            onClick={() => onExport('insurance')}
          >
            {t('payroll.outputs.insurance')}
          </button>
        ) : null}
        {run.can.exportBankFile ? (
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={pending}
            onClick={() => onExport('bank')}
          >
            {t('payroll.outputs.bank')}
          </button>
        ) : null}
      </div>
      {!sensitive ? (
        <p className="text-sm text-content-muted">{t('payroll.outputs.notSensitive')}</p>
      ) : !run.can.exportBankFile ? (
        <p className="text-sm text-content-muted">{t('payroll.outputs.noBankFile')}</p>
      ) : (
        <p className="text-sm text-content-muted">{t('payroll.outputs.audited')}</p>
      )}
      {error === null ? null : <PayrollFailure error={error} />}
    </section>
  );
}

/** Every payslip of an approved run, on screen and one to a printed page. */
function RunPayslips({
  run,
  month,
  onBack,
}: {
  run: PayRunDetail;
  month: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const access = usePayrollAccess();
  const [language, setLanguage] = useState(() => languageOf(locale));
  const payslips = useQuery({
    queryKey: keys.runPayslips(run.id),
    queryFn: async () =>
      (
        await client.GET('/v1/payroll/runs/{runId}/payslips', {
          params: { path: { runId: run.id } },
        })
      ).data!.items,
  });
  return (
    <div className="flex flex-col gap-6 text-start">
      <div className="flex flex-col gap-4 print:hidden">
        <button type="button" className={`${buttonClass.ghost} self-start`} onClick={onBack}>
          {t('payroll.payslips.back')}
        </button>
        <h1 className="text-2xl font-semibold text-content">
          {t('payroll.payslips.title', { month })}
        </h1>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PayslipLanguagePicker value={language} onChange={setLanguage} />
          {payslips.data === undefined || payslips.data.length === 0 ? null : (
            <PrintButton label={t('payroll.payslips.print')} />
          )}
        </div>
      </div>
      {payslips.isPending ? (
        <Loading />
      ) : payslips.isError ? (
        <PayrollFailure error={payslips.error} onRetry={() => void payslips.refetch()} />
      ) : payslips.data.length === 0 ? (
        <Notice>
          <p>{t('payroll.payslips.empty')}</p>
        </Notice>
      ) : (
        <PayslipStack payslips={payslips.data} language={language} company={access.company} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lines
// ---------------------------------------------------------------------------

const HEADINGS = [
  'employee',
  'basicAllowances',
  'overtime',
  'bonus',
  'deduction',
  'unpaid',
  'gross',
  'siEmployee',
  'incomeTax',
  'martyrsFund',
  'reimbursements',
  'net',
  'siEmployer',
] as const;

function Lines({
  run,
  editing,
  onEdit,
  onSaved,
}: {
  run: PayRunDetail;
  editing: string | null;
  onEdit: (lineId: string | null) => void;
  onSaved: (next: PayRunDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const columns = HEADINGS.length + (run.can.edit ? 1 : 0);
  return (
    <section aria-labelledby="run-lines" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="run-lines" className="text-base font-semibold text-content">
          {t('payroll.lines.title')}
        </h2>
        {run.can.edit ? (
          <p className="text-sm text-content-muted">{t('payroll.lines.editIntro')}</p>
        ) : null}
      </div>
      {run.lines.length === 0 ? (
        <Notice>
          <p>{t('payroll.lines.empty')}</p>
        </Notice>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full min-w-[72rem] text-sm">
            <caption className="sr-only">{t('payroll.lines.title')}</caption>
            <thead className="border-b border-border-subtle text-xs text-content-muted">
              <tr>
                {HEADINGS.map((heading, index) => (
                  <th
                    key={heading}
                    scope="col"
                    className={`px-3 py-2 font-medium ${index === 0 ? 'text-start' : 'text-end'}`}
                  >
                    {t(`payroll.lines.${heading}`)}
                  </th>
                ))}
                {run.can.edit ? (
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    <span className="sr-only">{t('payroll.lines.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {run.lines.map((line) =>
                editing === line.id ? (
                  <LineEditor
                    key={line.id}
                    run={run}
                    line={line}
                    columns={columns}
                    onCancel={() => onEdit(null)}
                    onSaved={onSaved}
                  />
                ) : (
                  <LineRow
                    key={line.id}
                    run={run}
                    line={line}
                    onEdit={run.can.edit && editing === null ? () => onEdit(line.id) : null}
                    editable={run.can.edit}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The cells every line shows the same way, read or being edited. */
function useLineCells(run: PayRunDetail, line: PayLine) {
  const { t } = useTranslation();
  const { locale, paths } = useOperations();
  const money = (value: string, strong = false) => (
    <Amount value={value} currency={run.currency} strong={strong} />
  );
  const cell = 'px-3 py-2 text-end align-top';
  return {
    cell,
    money,
    employee: (
      <th scope="row" className="px-3 py-2 text-start align-top font-normal">
        <AppLink to={paths.employee(line.employee.id)} className="font-medium">
          <span dir="auto">{line.employee.name}</span>
        </AppLink>
        <span className="block text-xs text-content-muted">
          {t(`payroll.payMethod.${line.payMethod}`)}
          {line.insured ? null : ` · ${t('payroll.lines.notInsured')}`}
        </span>
        {line.note === null ? null : (
          <span className="block max-w-48 text-xs text-content-muted" dir="auto">
            {line.note}
          </span>
        )}
      </th>
    ),
    basic: (
      <td className={cell}>
        <span className="block">{money(line.basic)}</span>
        <span className="block text-xs text-content-muted">
          {t('payroll.lines.plusAllowances', {
            amount: formatAmount(line.allowances, run.currency, locale),
          })}
        </span>
      </td>
    ),
    after: (
      <>
        <td className={cell}>{money(line.gross)}</td>
        <td className={cell}>{money(line.socialInsuranceEmployee)}</td>
        <td className={cell}>{money(line.incomeTax)}</td>
        <td className={cell}>{money(line.martyrsFund)}</td>
        <td className={cell}>{money(line.reimbursements)}</td>
        <td className={`${cell} ${line.net.startsWith('-') ? 'text-danger' : ''}`}>
          {money(line.net, true)}
        </td>
        <td className={`${cell} text-content-muted`}>{money(line.socialInsuranceEmployer)}</td>
      </>
    ),
  };
}

function LineRow({
  run,
  line,
  onEdit,
  editable,
}: {
  run: PayRunDetail;
  line: PayLine;
  onEdit: (() => void) | null;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const { cell, money, employee, basic, after } = useLineCells(run, line);
  return (
    <tr>
      {employee}
      {basic}
      <td className={cell}>
        <span className="block tabular-nums">
          {t('payroll.lines.hours', { hours: formatQuantity(line.overtimeHours, locale) })}
        </span>
        <span className="block">{money(line.overtimePay)}</span>
        <span className="block text-xs text-content-muted">
          {t('payroll.lines.clocked', { hours: formatQuantity(line.clockedHours, locale) })}
        </span>
      </td>
      <td className={cell}>{money(line.bonus)}</td>
      <td className={cell}>{money(line.deduction)}</td>
      <td className={cell}>
        <span className="block tabular-nums">
          {t('payroll.lines.days', { days: formatQuantity(line.unpaidDays, locale) })}
        </span>
        <span className="block">{money(line.unpaidLeave)}</span>
      </td>
      {after}
      {editable ? (
        <td className={cell}>
          {onEdit === null ? null : (
            <button
              type="button"
              className={buttonClass.ghost}
              aria-label={t('payroll.lines.editLabel', { name: line.employee.name })}
              onClick={onEdit}
            >
              {t('payroll.lines.edit')}
            </button>
          )}
        </td>
      ) : null}
    </tr>
  );
}

/**
 * A line being typed into: overtime hours, bonus, deduction, unpaid days and a
 * note, checked as the API checks them; the server works out the rest.
 */
function LineEditor({
  run,
  line,
  columns,
  onCancel,
  onSaved,
}: {
  run: PayRunDetail;
  line: PayLine;
  columns: number;
  onCancel: () => void;
  onSaved: (next: PayRunDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [form, setForm] = useState({
    overtimeHours: line.overtimeHours,
    bonus: line.bonus,
    deduction: line.deduction,
    unpaidDays: line.unpaidDays,
    note: line.note ?? '',
  });
  const [tried, setTried] = useState(false);
  const { cell, employee, basic, after } = useLineCells(run, line);
  const name = line.employee.name;
  const formId = `pay-line-${line.id}`;

  const problems = {
    overtimeHours: !isHours(form.overtimeHours),
    bonus: !isMoney(form.bonus),
    deduction: !isMoney(form.deduction),
    unpaidDays: !isDays(form.unpaidDays),
  };
  const invalid = Object.values(problems).some(Boolean);

  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/payroll/runs/{runId}/lines/{lineId}', {
          params: { path: { runId: run.id, lineId: line.id } },
          body: {
            expectedRunVersion: run.version,
            expectedVersion: line.version,
            overtimeHours: form.overtimeHours.trim(),
            bonus: form.bonus.trim(),
            deduction: form.deduction.trim(),
            unpaidDays: form.unpaidDays.trim(),
            note: form.note.trim() === '' ? null : form.note.trim(),
          },
        })
      ).data!,
    onSuccess: onSaved,
  });

  const input = (
    field: keyof typeof problems,
    pattern: string,
    label: 'overtimeHoursLabel' | 'bonusLabel' | 'deductionLabel' | 'unpaidDaysLabel',
  ) => (
    <input
      form={formId}
      type="text"
      inputMode="decimal"
      dir="ltr"
      pattern={pattern}
      aria-label={t(`payroll.lines.${label}`, { name })}
      aria-invalid={tried && problems[field]}
      className={`${inputClass} w-24 text-end`}
      value={form[field]}
      onChange={(event) => setForm({ ...form, [field]: event.target.value })}
    />
  );

  return (
    <>
      <tr className="bg-surface-muted">
        {employee}
        {basic}
        <td className={cell}>{input('overtimeHours', HOURS_PATTERN, 'overtimeHoursLabel')}</td>
        <td className={cell}>{input('bonus', MONEY_PATTERN, 'bonusLabel')}</td>
        <td className={cell}>{input('deduction', MONEY_PATTERN, 'deductionLabel')}</td>
        <td className={cell}>{input('unpaidDays', DAYS_PATTERN, 'unpaidDaysLabel')}</td>
        {after}
        <td className={cell} />
      </tr>
      <tr className="bg-surface-muted">
        <td colSpan={columns} className="px-3 pb-3">
          <form
            id={formId}
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setTried(true);
              if (!invalid) {
                save.mutate();
              }
            }}
          >
            <Field label={t('payroll.lines.noteFor', { name })} className="max-w-xl">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  dir="auto"
                  maxLength={1000}
                  className={inputClass}
                  value={form.note}
                  onChange={(event) => setForm({ ...form, note: event.target.value })}
                />
              )}
            </Field>
            {tried && invalid ? (
              <p role="alert" className="text-sm text-danger">
                {t('payroll.lines.invalid')}
              </p>
            ) : null}
            {save.isError ? <PayrollFailure error={save.error} /> : null}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass.primary} disabled={save.isPending}>
                {save.isPending ? t('payroll.saving') : t('payroll.lines.save')}
              </button>
              <button type="button" className={buttonClass.secondary} onClick={onCancel}>
                {t('payroll.cancel')}
              </button>
            </div>
          </form>
        </td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** The pay date and a note for the run, while a draft. */
function DetailsDialog({
  run,
  onClose,
  onDone,
}: {
  run: PayRunDetail;
  onClose: () => void;
  onDone: (next: PayRunDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [payDate, setPayDate] = useState(run.payDate ?? '');
  const [note, setNote] = useState(run.note ?? '');
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/payroll/runs/{runId}', {
          params: { path: { runId: run.id } },
          body: {
            expectedVersion: run.version,
            payDate: payDate === '' ? null : payDate,
            note: note.trim() === '' ? null : note.trim(),
          },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('payroll.run.editDetails')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="submit"
            form="payroll-run-details"
            className={buttonClass.primary}
            disabled={save.isPending}
          >
            {save.isPending ? t('payroll.saving') : t('payroll.save')}
          </button>
        </>
      }
    >
      <form
        id="payroll-run-details"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('payroll.run.payDate')} hint={t('payroll.run.payDateHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              aria-describedby={describedBy}
              className={inputClass}
              value={payDate}
              onChange={(event) => setPayDate(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('payroll.run.note')}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              dir="auto"
              maxLength={1000}
              className={inputClass}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        {save.isError ? <PayrollFailure error={save.error} /> : null}
      </form>
    </Dialog>
  );
}

/** Approving is final: said plainly, with the totals, before it is done. */
function ApproveDialog({
  run,
  month,
  onClose,
  onDone,
}: {
  run: PayRunDetail;
  month: string;
  onClose: () => void;
  onDone: (next: PayRunDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const approve = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/payroll/runs/{runId}/approve', {
          params: { path: { runId: run.id } },
          body: { expectedVersion: run.version },
        })
      ).data!,
    onSuccess: onDone,
  });
  const outOfDate = errorCode(approve.error) === 'run_out_of_date';
  return (
    <Dialog
      title={t('payroll.approve.title', { month })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={approve.isPending || outOfDate}
            onClick={() => approve.mutate()}
          >
            {approve.isPending ? t('payroll.approve.approving') : t('payroll.approve.action')}
          </button>
        </>
      }
    >
      <p>
        {t('payroll.approve.intro', {
          count: run.totals.employees,
          net: formatAmount(run.totals.net, run.currency, locale),
        })}
      </p>
      <p>{t('payroll.approve.final')}</p>
      {approve.isError ? <PayrollFailure error={approve.error} /> : null}
    </Dialog>
  );
}

/** Discards a draft; the month may then be prepared again. */
function DiscardDialog({
  run,
  month,
  onClose,
  onDone,
}: {
  run: PayRunDetail;
  month: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const discard = useMutation({
    mutationFn: async () => {
      await client.DELETE('/v1/payroll/runs/{runId}', { params: { path: { runId: run.id } } });
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('payroll.discard.title', { month })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={discard.isPending}
            onClick={() => discard.mutate()}
          >
            {discard.isPending ? t('payroll.discard.discarding') : t('payroll.discard.action')}
          </button>
        </>
      }
    >
      <p>{t('payroll.discard.intro')}</p>
      {discard.isError ? <PayrollFailure error={discard.error} /> : null}
    </Dialog>
  );
}
