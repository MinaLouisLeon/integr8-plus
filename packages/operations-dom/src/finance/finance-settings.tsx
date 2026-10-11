import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type FinanceSettings, keys, useOperations } from '../api.js';
import { isPositiveQuantity, QUANTITY_PATTERN } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * What the company prints on its invoices (CRM/ERP plan, phase B1; ADR-0007):
 * its legal name, address, tax reference, how to pay and a footer, the days
 * an invoice is due in, and the hourly labour cost and rate. Printed as typed:
 * a commercial record, not a certified tax document.
 */

interface Draft {
  legalName: string;
  address: string;
  taxReference: string;
  paymentInstructions: string;
  footer: string;
  defaultDueDays: string;
  labourHourlyCost: string;
  labourHourlyRate: string;
}

function draftOf(settings: FinanceSettings): Draft {
  return {
    legalName: settings.legalName ?? '',
    address: settings.address ?? '',
    taxReference: settings.taxReference ?? '',
    paymentInstructions: settings.paymentInstructions ?? '',
    footer: settings.footer ?? '',
    defaultDueDays: String(settings.defaultDueDays),
    labourHourlyCost: settings.labourHourlyCost ?? '',
    labourHourlyRate: settings.labourHourlyRate ?? '',
  };
}

const textOrNull = (value: string) => (value.trim() === '' ? null : value.trim());
const rateValid = (value: string) => value.trim() === '' || isPositiveQuantity(value.trim());
const daysValid = (value: string) => /^\d{1,3}$/.test(value) && Number(value) <= 365;

export function FinanceSettingsScreen() {
  const { t } = useTranslation();
  const { client, paths } = useOperations();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: keys.financeSettings,
    queryFn: async () => (await client.GET('/v1/finance/settings')).data!,
  });
  const save = useMutation({
    mutationFn: async (values: Draft) =>
      (
        await client.PUT('/v1/finance/settings', {
          body: {
            expectedVersion: settings.data!.version,
            legalName: textOrNull(values.legalName),
            address: textOrNull(values.address),
            taxReference: textOrNull(values.taxReference),
            paymentInstructions: textOrNull(values.paymentInstructions),
            footer: textOrNull(values.footer),
            defaultDueDays: Number(values.defaultDueDays),
            labourHourlyCost: textOrNull(values.labourHourlyCost),
            labourHourlyRate: textOrNull(values.labourHourlyRate),
          },
        })
      ).data!,
    onSuccess: async (next) => {
      queries.setQueryData(keys.financeSettings, next);
      setDraft(null);
      setSaved(true);
      await queries.invalidateQueries({ queryKey: ['finance'] });
    },
  });

  if (settings.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.invoices} label={t('finance.invoices.back')} />;
  if (settings.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={settings.error} onRetry={() => void settings.refetch()} />
      </div>
    );
  }

  const current = settings.data;
  const values = draft ?? draftOf(current);
  const editable = current.can.edit;
  const set = (key: keyof Draft) => (value: string) => {
    setSaved(false);
    setDraft({ ...values, [key]: value });
  };
  const valid =
    daysValid(values.defaultDueDays) &&
    rateValid(values.labourHourlyCost) &&
    rateValid(values.labourHourlyRate);

  const text = (
    key: Exclude<keyof Draft, 'defaultDueDays' | 'labourHourlyCost' | 'labourHourlyRate'>,
    max: number,
    options: { multiline?: boolean; hint?: string } = {},
  ) => (
    <Field
      label={t(`finance.settings.${key}`)}
      {...(options.hint === undefined ? {} : { hint: options.hint })}
    >
      {(id, describedBy) =>
        options.multiline === true ? (
          <textarea
            id={id}
            aria-describedby={describedBy}
            rows={3}
            maxLength={max}
            dir="auto"
            disabled={!editable}
            className={inputClass}
            value={values[key]}
            onChange={(event) => set(key)(event.target.value)}
          />
        ) : (
          <input
            id={id}
            aria-describedby={describedBy}
            maxLength={max}
            dir="auto"
            disabled={!editable}
            className={inputClass}
            value={values[key]}
            onChange={(event) => set(key)(event.target.value)}
          />
        )
      }
    </Field>
  );
  const rate = (key: 'labourHourlyCost' | 'labourHourlyRate') => (
    <Field label={t(`finance.settings.${key}`)} hint={t(`finance.settings.${key}Hint`)}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          inputMode="decimal"
          dir="ltr"
          pattern={QUANTITY_PATTERN}
          disabled={!editable}
          className={inputClass}
          value={values[key]}
          onChange={(event) => set(key)(event.target.value.trim())}
        />
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('finance.settings.title')}</h1>
        <p className="text-sm text-content-muted">{t('finance.settings.intro')}</p>
        <p className="text-sm text-content-muted">{t('finance.settings.notCertified')}</p>
      </header>

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (editable && valid) {
            save.mutate(values);
          }
        }}
      >
        <section className={`${cardClass} flex flex-col gap-3`} aria-labelledby="finance-issuer">
          <h2 id="finance-issuer" className="text-lg font-semibold text-content">
            {t('finance.settings.issuer')}
          </h2>
          {text('legalName', 200, {
            hint: t('finance.settings.legalNameHint', { name: current.companyName }),
          })}
          {text('address', 1000, { multiline: true })}
          {text('taxReference', 100)}
          {text('paymentInstructions', 2000, { multiline: true })}
          {text('footer', 2000, { multiline: true })}
        </section>

        <section className={`${cardClass} flex flex-col gap-3`} aria-labelledby="finance-terms">
          <h2 id="finance-terms" className="text-lg font-semibold text-content">
            {t('finance.settings.terms')}
          </h2>
          <Field
            label={t('finance.settings.defaultDueDays')}
            hint={t('finance.settings.defaultDueDaysHint')}
          >
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                dir="ltr"
                pattern="\d{1,3}"
                required
                disabled={!editable}
                className={`${inputClass} max-w-32`}
                value={values.defaultDueDays}
                onChange={(event) => set('defaultDueDays')(event.target.value.trim())}
              />
            )}
          </Field>
          {current.can.edit || current.labourHourlyCost !== null ? rate('labourHourlyCost') : null}
          {rate('labourHourlyRate')}
        </section>

        {save.isError ? <Failure error={save.error} /> : null}
        {saved ? (
          <p role="status" className="text-sm text-content">
            {t('finance.settings.saved')}
          </p>
        ) : null}
        {editable ? (
          <div className="flex gap-2">
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={draft === null || !valid || save.isPending}
            >
              {save.isPending ? t('finance.saving') : t('finance.save')}
            </button>
            {draft === null ? null : (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDraft(null)}
              >
                {t('finance.cancel')}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-content-muted">{t('finance.settings.readOnly')}</p>
        )}
      </form>
    </div>
  );
}
