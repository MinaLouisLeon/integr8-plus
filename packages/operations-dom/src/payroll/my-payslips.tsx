import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { Amount, formatMonth } from '../ledger/ledger-parts.js';
import { buttonClass, DashboardBackLink, Loading } from '../ui.js';
import { languageOf, Notice, PayrollFailure, usePayrollAccess } from './payroll-parts.js';
import { PayslipDocument, PayslipLanguagePicker, PrintButton } from './payslip.js';

/**
 * The signed-in person's own payslips, from approved runs, latest first
 * (ADR-0010). Every member has this when the company runs payroll; one is
 * opened to read and print, in English or Arabic.
 */
export function MyPayslipsScreen() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const access = usePayrollAccess();
  const [openId, setOpenId] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => languageOf(locale));

  const payslips = useQuery({
    queryKey: keys.myPayslips,
    queryFn: async () =>
      (await client.GET('/v1/hr/me/payslips', { params: { query: { limit: 24 } } })).data!.items,
    enabled: access.enabled,
  });

  const header = (
    <header className="flex flex-col gap-2 print:hidden">
      <h1 className="text-2xl font-semibold text-content">{t('payroll.mine.title')}</h1>
      <p className="text-sm text-content-muted">{t('payroll.mine.intro')}</p>
    </header>
  );

  if (access.loaded && !access.enabled) {
    return (
      <div className="flex flex-col gap-6 text-start">
        <DashboardBackLink />
        {header}
        <Notice>
          <p>{t('errors.featureDisabled')}</p>
        </Notice>
      </div>
    );
  }

  const opened = payslips.data?.find((payslip) => payslip.run.id === openId);

  return (
    <div className="flex flex-col gap-6 text-start">
      <div className="print:hidden">
        <DashboardBackLink />
      </div>
      {header}
      {payslips.isPending ? (
        <Loading />
      ) : payslips.isError ? (
        <PayrollFailure error={payslips.error} onRetry={() => void payslips.refetch()} />
      ) : payslips.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">{t('payroll.mine.empty')}</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface print:hidden">
            {payslips.data.map((payslip) => {
              const month = formatMonth(payslip.run.periodStart, locale);
              const open = payslip.run.id === openId;
              return (
                <li
                  key={payslip.run.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-content">{month}</span>
                    <span className="text-sm text-content-muted" dir="ltr">
                      {payslip.run.reference}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-content-muted">{t('payroll.mine.net')}</span>
                    <Amount value={payslip.line.net} currency={payslip.run.currency} strong />
                    <button
                      type="button"
                      className={buttonClass.secondary}
                      aria-expanded={open}
                      aria-label={t(open ? 'payroll.mine.closeLabel' : 'payroll.mine.openLabel', {
                        month,
                      })}
                      onClick={() => setOpenId(open ? null : payslip.run.id)}
                    >
                      {t(open ? 'payroll.mine.close' : 'payroll.mine.open')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {opened === undefined ? null : (
            <section className="flex flex-col gap-4" aria-label={t('payroll.mine.opened')}>
              <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
                <PayslipLanguagePicker value={language} onChange={setLanguage} />
                <PrintButton label={t('payroll.mine.print')} />
              </div>
              <PayslipDocument payslip={opened} language={language} company={access.company} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
