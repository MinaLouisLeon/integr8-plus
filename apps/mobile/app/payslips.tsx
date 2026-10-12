import { useTranslation } from '@integr8/i18n';
import { radii, spacing } from '@integr8/tokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { OnlineStatus } from '~/components/online';
import {
  BackButton,
  Body,
  Button,
  Detail,
  EmptyState,
  Heading,
  ScrollScreen,
  useTheme,
} from '~/components/ui';
import { formatMoney, formatQuantity } from '~/lib/format';
import { fetchMyPayslips, type Payslip } from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * One's own payslips, read only (ADR-0012), from `/v1/hr/me/payslips`: the
 * approved pay runs' lines for the signed-in employee, latest first, each
 * headed by the company that pays, as the printed payslip is. Online: a
 * payslip is the office's to show, so the phone keeps no copy of it.
 */
export default function PayslipsScreen() {
  const { t } = useTranslation();
  const { state, reload } = useOnlineRequest('payslips', fetchMyPayslips);

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.payslips.title')}</Heading>
      <Body muted>{t('mobile.payslips.intro')}</Body>
      {state.status !== 'ready' ? (
        <OnlineStatus state={state} onRetry={reload} />
      ) : state.data.length === 0 ? (
        <EmptyState title={t('mobile.payslips.none')} body="" />
      ) : (
        state.data.map((slip) => <PayslipCard key={slip.run.id} slip={slip} />)
      )}
    </ScrollScreen>
  );
}

function PayslipCard({ slip }: { slip: Payslip }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const { company, run, employee, line } = slip;
  const money = (amount: string) => formatMoney(amount, run.currency, i18n.language);
  const day = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(`${value}T12:00:00Z`));
  const month = new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }).format(
    new Date(`${run.periodStart}T12:00:00Z`),
  );
  const amount = (label: string, value: string, detail?: string) => (
    <Detail label={label}>
      <View>
        <Body>{money(value)}</Body>
        {detail === undefined ? null : <Body muted>{detail}</Body>}
      </View>
    </Detail>
  );

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Heading>{t('payroll.payslip.title', { month })}</Heading>
      <Body>{t('mobile.payslips.from', { company: company.name })}</Body>
      {company.address === null ? null : <Body muted>{company.address}</Body>}
      {company.taxReference === null ? null : (
        <Body muted>{t('mobile.payslips.taxReference', { reference: company.taxReference })}</Body>
      )}
      <Body muted>
        {run.reference} ·{' '}
        {t('mobile.payslips.period', { from: day(run.periodStart), to: day(run.periodEnd) })}
      </Body>
      {run.payDate === null ? null : (
        <Body muted>{t('mobile.payslips.paidOn', { date: day(run.payDate) })}</Body>
      )}
      <Body>{t('mobile.payslips.net', { amount: money(line.net) })}</Body>
      <View style={styles.toggle}>
        <Button
          label={open ? t('mobile.payslips.close') : t('mobile.payslips.open')}
          variant="secondary"
          onPress={() => setOpen((value) => !value)}
        />
      </View>
      {open ? (
        <View style={styles.breakdown}>
          <Detail label={t('payroll.payslip.employee')}>{employee.name}</Detail>
          {employee.employeeNumber === null ? null : (
            <Detail label={t('payroll.payslip.employeeNumber')}>{employee.employeeNumber}</Detail>
          )}
          {employee.jobTitle === null ? null : (
            <Detail label={t('payroll.payslip.jobTitle')}>{employee.jobTitle}</Detail>
          )}
          <Detail label={t('payroll.payslip.payMethod')}>
            {t(`payroll.payMethod.${line.payMethod}`)}
          </Detail>
          {amount(t('payroll.payslip.basic'), line.basic)}
          {amount(t('payroll.payslip.allowances'), line.allowances)}
          {amount(
            t('payroll.payslip.overtime'),
            line.overtimePay,
            t('payroll.payslip.overtimeDetail', {
              hours: formatQuantity(line.overtimeHours, i18n.language),
              rate: money(line.overtimeRate),
            }),
          )}
          {amount(t('payroll.payslip.bonus'), line.bonus)}
          {amount(t('payroll.payslip.deduction'), line.deduction)}
          {amount(
            t('payroll.payslip.unpaidLeave'),
            line.unpaidLeave,
            t('payroll.payslip.unpaidDetail', {
              days: formatQuantity(line.unpaidDays, i18n.language),
            }),
          )}
          {amount(t('payroll.payslip.gross'), line.gross)}
          {amount(
            t('payroll.payslip.socialInsurance'),
            line.socialInsuranceEmployee,
            line.insured
              ? t('payroll.payslip.insurableDetail', { wage: money(line.insurableWage) })
              : t('payroll.payslip.notInsured'),
          )}
          {amount(t('payroll.payslip.incomeTax'), line.incomeTax)}
          {amount(t('payroll.payslip.martyrsFund'), line.martyrsFund)}
          {amount(
            t('payroll.payslip.reimbursements'),
            line.reimbursements,
            t('payroll.payslip.reimbursementsDetail'),
          )}
          {amount(t('payroll.payslip.net'), line.net)}
          {line.insured ? (
            <Body muted>
              {t('payroll.payslip.employerShare', { amount: money(line.socialInsuranceEmployer) })}
            </Body>
          ) : null}
          {line.note === null ? null : (
            <Detail label={t('payroll.payslip.note')}>{line.note}</Detail>
          )}
          <Detail label={t('payroll.disclaimerLabel')}>{t('payroll.disclaimer')}</Detail>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  toggle: { alignItems: 'flex-start' },
  breakdown: { gap: spacing[3] },
});
