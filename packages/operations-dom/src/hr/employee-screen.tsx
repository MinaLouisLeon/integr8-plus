import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type Employee, keys, useOperations } from '../api.js';
import { BackLink, buttonClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import { EmployeeDetails, EmployeeStatusBadge, HrFailure } from './hr-parts.js';

/**
 * One employee (ADR-0010): the job, who they sign in as, ID and bank details
 * for those who may see them — the last four, and the whole number only when
 * asked for — and an emergency contact. Those who manage HR edit the profile,
 * end the employment with a date and a reason, or bring somebody back.
 */
export function EmployeeScreen({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const [dialog, setDialog] = useState<'end' | 'bringBack' | null>(null);

  const detail = useQuery({
    queryKey: keys.employee(employeeId),
    queryFn: async () =>
      (await client.GET('/v1/hr/employees/{employeeId}', { params: { path: { employeeId } } }))
        .data!,
  });
  const settle = async (next: Employee) => {
    setDialog(null);
    queries.setQueryData(keys.employee(next.id), next);
    await queries.invalidateQueries({ queryKey: ['hr'] });
  };

  const back = <BackLink to={paths.employees} label={t('hr.employee.back')} />;
  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <HrFailure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const employee = detail.data;
  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span dir="auto">{employee.fullName}</span>
            <EmployeeStatusBadge status={employee.status} />
          </h1>
          {employee.jobTitle === null ? null : (
            <p className="text-sm text-content-muted" dir="auto">
              {employee.jobTitle}
            </p>
          )}
        </div>
        {employee.can.edit ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => navigate(paths.editEmployee(employee.id))}
            >
              {t('hr.employee.edit')}
            </button>
            {employee.status === 'active' ? (
              <button type="button" className={buttonClass.danger} onClick={() => setDialog('end')}>
                {t('hr.employee.end')}
              </button>
            ) : (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDialog('bringBack')}
              >
                {t('hr.employee.bringBack')}
              </button>
            )}
          </div>
        ) : null}
      </header>

      <EmployeeDetails employee={employee} />

      {dialog === 'end' ? (
        <EndDialog employee={employee} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'bringBack' ? (
        <BringBackDialog employee={employee} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
    </div>
  );
}

/** Today in the reader's own calendar, as the API writes a date. */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Ends the employment: a date on or after the hire date, and a reason, both
 * required. The profile stays, with its history; signing in is People's
 * business and is said so.
 */
function EndDialog({
  employee,
  onClose,
  onDone,
}: {
  employee: Employee;
  onClose: () => void;
  onDone: (next: Employee) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [endDate, setEndDate] = useState(() => {
    const now = today();
    return now < employee.hireDate ? employee.hireDate : now;
  });
  const [endReason, setEndReason] = useState('');
  const [tried, setTried] = useState(false);
  const hire = formatCalendarDate(employee.hireDate, { locale });

  const dateProblem =
    endDate === ''
      ? t('hr.employee.endDateHint', { date: hire })
      : endDate < employee.hireDate
        ? t('hr.employee.endBeforeHire', { date: hire })
        : null;
  const reasonProblem = endReason.trim() === '' ? t('hr.employee.endReasonRequired') : null;

  const end = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/hr/employees/{employeeId}', {
          params: { path: { employeeId: employee.id } },
          body: { expectedVersion: employee.version, endDate, endReason: endReason.trim() },
        })
      ).data!,
    onSuccess: onDone,
  });

  return (
    <Dialog
      title={t('hr.employee.endTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('hr.cancel')}
          </button>
          <button
            type="submit"
            form="hr-end-employment"
            className={buttonClass.danger}
            disabled={end.isPending}
          >
            {end.isPending ? t('hr.employee.ending') : t('hr.employee.end')}
          </button>
        </>
      }
    >
      <form
        id="hr-end-employment"
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (dateProblem === null && reasonProblem === null) {
            end.mutate();
          }
        }}
      >
        <p>{t('hr.employee.endIntro')}</p>
        <Field
          label={t('hr.field.endDate')}
          hint={
            tried && dateProblem !== null
              ? dateProblem
              : t('hr.employee.endDateHint', { date: hire })
          }
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              dir="ltr"
              required
              min={employee.hireDate}
              aria-describedby={describedBy}
              aria-invalid={tried && dateProblem !== null}
              className={inputClass}
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('hr.field.endReason')}
          {...(tried && reasonProblem !== null ? { hint: reasonProblem } : {})}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={3}
              dir="auto"
              required
              maxLength={1000}
              aria-describedby={describedBy}
              aria-invalid={tried && reasonProblem !== null}
              className={inputClass}
              value={endReason}
              onChange={(event) => setEndReason(event.target.value)}
            />
          )}
        </Field>
        {end.isError ? <HrFailure error={end.error} /> : null}
      </form>
    </Dialog>
  );
}

/** Clears the end date and reason together, so the person is active again. */
function BringBackDialog({
  employee,
  onClose,
  onDone,
}: {
  employee: Employee;
  onClose: () => void;
  onDone: (next: Employee) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const bringBack = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/hr/employees/{employeeId}', {
          params: { path: { employeeId: employee.id } },
          body: { expectedVersion: employee.version, endDate: null, endReason: null },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('hr.employee.bringBackTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('hr.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={bringBack.isPending}
            onClick={() => bringBack.mutate()}
          >
            {bringBack.isPending ? t('hr.employee.bringingBack') : t('hr.employee.bringBack')}
          </button>
        </>
      }
    >
      <p>{t('hr.employee.bringBackIntro', { name: employee.fullName })}</p>
      {bringBack.isError ? <HrFailure error={bringBack.error} /> : null}
    </Dialog>
  );
}
