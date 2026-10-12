import { hasFeature, type Role } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import {
  type Employee,
  type EmployeeStatus,
  keys,
  type SealedFieldName,
  useOperations,
} from '../api.js';
import { buttonClass, cardClass, Failure } from '../ui.js';

/**
 * Pieces the HR screens share (seventh round; ADR-0010): who may do what,
 * the refusals the server gives in words of this language, an employee's
 * details, and the ID and bank numbers shown in full only when asked for.
 *
 * A revealed number is kept in the state of the row that asked for it and
 * nowhere else: not in the query cache, not in a mutation's result. It goes
 * when the screen does, so it is not there for the next person at the desk.
 */

/** The numbers sealed at rest, in the order every screen lists them. */
export const SEALED_FIELDS: readonly SealedFieldName[] = [
  'nationalId',
  'insuranceNumber',
  'bankAccount',
];

/** What the API accepts for a sealed number: letters, digits, spaces and dashes, four to forty. */
export const SECRET_PATTERN = '[0-9A-Za-z][0-9A-Za-z \\-]{3,39}';
export function isSecret(text: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z -]{3,39}$/u.test(text.trim());
}

/** What this seat may do with the company's HR. */
export function useHrAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions: readonly string[] = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'hr');
  return {
    loaded: me.data !== undefined,
    enabled,
    userId: me.data?.userId ?? null,
    read: enabled && permissions.includes('hr.read'),
    sensitive: enabled && permissions.includes('hr.sensitive'),
    manage: enabled && permissions.includes('hr.manage'),
  };
}

/**
 * A request HR refused, in words. HR's refusals are said as everywhere else
 * (ADR-0012); kept as its own name so the HR screens read as one area.
 */
export function HrFailure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <Failure error={error} onRetry={onRetry} />;
}

/** A short note, such as why a form is not offered. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-muted p-4 text-start text-sm text-content">
      {children}
    </div>
  );
}

/** Whether somebody still works here, in words. */
export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        status === 'active'
          ? 'border-success text-content'
          : 'border-border-subtle bg-surface-muted text-content-muted'
      }`}
    >
      {t(`hr.status.${status}`)}
    </span>
  );
}

export function Fact({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </div>
  );
}

/** A value, or that none is recorded. */
function OrNone({ value, ltr = false }: { value: string | null; ltr?: boolean }) {
  const { t } = useTranslation();
  if (value === null || value === '') {
    return <span className="text-content-muted">{t('hr.employee.none')}</span>;
  }
  return ltr ? <span dir="ltr">{value}</span> : <span dir="auto">{value}</span>;
}

/**
 * One sealed number: its last four, and on request the whole of it. The
 * reveal is audited by the server; the value is held here until the screen
 * goes or the person hides it.
 */
function SealedValue({
  employeeId,
  field,
  masked,
  canReveal,
}: {
  employeeId: string;
  field: SealedFieldName;
  masked: { last4: string } | null;
  canReveal: boolean;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [shown, setShown] = useState<{ value: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const label = t(`hr.field.${field}`);

  if (masked === null) {
    return <OrNone value={null} />;
  }

  const reveal = async () => {
    setPending(true);
    setError(null);
    try {
      const { data } = await client.POST('/v1/hr/employees/{employeeId}/reveal', {
        params: { path: { employeeId } },
        body: { field },
      });
      setShown({ value: data!.value });
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="flex flex-col items-start gap-2">
      <span className="flex flex-wrap items-center gap-2">
        {shown === null ? (
          <span>{t('hr.sensitive.masked', { last4: masked.last4 })}</span>
        ) : (
          <span dir="ltr" className="font-mono">
            {shown.value ?? t('hr.employee.none')}
          </span>
        )}
        {!canReveal ? null : shown === null ? (
          <button
            type="button"
            className={buttonClass.ghost}
            aria-label={t('hr.sensitive.showLabel', { field: label })}
            disabled={pending}
            onClick={() => void reveal()}
          >
            {pending ? t('hr.sensitive.showing') : t('hr.sensitive.show')}
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass.ghost}
            aria-label={t('hr.sensitive.hideLabel', { field: label })}
            onClick={() => setShown(null)}
          >
            {t('hr.sensitive.hide')}
          </button>
        )}
      </span>
      {error === null ? null : <HrFailure error={error} />}
    </span>
  );
}

/**
 * An employee's details, as their own profile and as the HR screen show them:
 * the job, who they sign in as, ID and bank details where this seat may see
 * them, and who to call in an emergency.
 */
export function EmployeeDetails({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const date = (value: string) => formatCalendarDate(value, { locale });
  const roleName = (role: Role) => t(`workspace.role.${role}`);

  return (
    <>
      <section aria-labelledby="employee-job" className={cardClass}>
        <h2 id="employee-job" className="text-base font-semibold text-content">
          {t('hr.employee.job')}
        </h2>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('hr.field.employeeNumber')}>
            <OrNone value={employee.employeeNumber} ltr />
          </Fact>
          <Fact label={t('hr.field.jobTitle')}>
            <OrNone value={employee.jobTitle} />
          </Fact>
          <Fact label={t('hr.field.department')}>
            <OrNone value={employee.department} />
          </Fact>
          <Fact label={t('hr.field.phone')}>
            <OrNone value={employee.phone} ltr />
          </Fact>
          <Fact label={t('hr.field.hireDate')}>{date(employee.hireDate)}</Fact>
          {employee.endDate === null ? null : (
            <>
              <Fact label={t('hr.field.endDate')}>{date(employee.endDate)}</Fact>
              <Fact label={t('hr.field.endReason')} wide>
                <OrNone value={employee.endReason} />
              </Fact>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="employee-sign-in" className={cardClass}>
        <h2 id="employee-sign-in" className="text-base font-semibold text-content">
          {t('hr.employee.signIn')}
        </h2>
        <p className="text-sm text-content">
          {employee.member === null
            ? t('hr.employee.noMember')
            : t('hr.employee.memberLinked', {
                name: employee.member.displayName,
                role: roleName(employee.member.role),
              })}
        </p>
      </section>

      {employee.sensitive === null ? null : (
        <section aria-labelledby="employee-sensitive" className={cardClass}>
          <div className="flex flex-col gap-1">
            <h2 id="employee-sensitive" className="text-base font-semibold text-content">
              {t('hr.employee.sensitive')}
            </h2>
            <p className="text-sm text-content-muted">{t('hr.employee.sensitiveNote')}</p>
          </div>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Fact label={t('hr.field.nationalId')}>
              <SealedValue
                // A new version may carry a new number: what was shown goes.
                key={`nationalId-${employee.version}`}
                employeeId={employee.id}
                field="nationalId"
                masked={employee.sensitive.nationalId}
                canReveal={employee.can.reveal}
              />
            </Fact>
            <Fact label={t('hr.field.insuranceNumber')}>
              <SealedValue
                key={`insuranceNumber-${employee.version}`}
                employeeId={employee.id}
                field="insuranceNumber"
                masked={employee.sensitive.insuranceNumber}
                canReveal={employee.can.reveal}
              />
            </Fact>
            <Fact label={t('hr.field.bankName')}>
              <OrNone value={employee.sensitive.bankName} />
            </Fact>
            <Fact label={t('hr.field.bankAccount')}>
              <SealedValue
                key={`bankAccount-${employee.version}`}
                employeeId={employee.id}
                field="bankAccount"
                masked={employee.sensitive.bankAccount}
                canReveal={employee.can.reveal}
              />
            </Fact>
          </dl>
        </section>
      )}

      <section aria-labelledby="employee-emergency" className={cardClass}>
        <h2 id="employee-emergency" className="text-base font-semibold text-content">
          {t('hr.employee.emergency')}
        </h2>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label={t('hr.field.emergencyName')}>
            <OrNone value={employee.emergencyContact.name} />
          </Fact>
          <Fact label={t('hr.field.emergencyPhone')}>
            <OrNone value={employee.emergencyContact.phone} ltr />
          </Fact>
        </dl>
      </section>
    </>
  );
}
