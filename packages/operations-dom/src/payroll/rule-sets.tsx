import { payrollRulesSchema, type PayrollRules, type TaxBand } from '@integr8/core';
import { formatDateTime, type TFunction, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type PayrollRuleSet, useOperations } from '../api.js';
import { Amount, formatMonth } from '../ledger/ledger-parts.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  DashboardBackLink,
  Dialog,
  Field,
  inputClass,
  Loading,
} from '../ui.js';
import {
  Disclaimer,
  disclaimerText,
  formatQuantity,
  Notice,
  PayrollFailure,
  usePayrollAccess,
} from './payroll-parts.js';

/**
 * The payroll rule sets (ADR-0010): each year's tax bands, social insurance
 * rates and limits and the Martyrs' Fund rate, from a month on. Integr8
 * offers the 2026 figures as a starting point; whoever keeps payroll adds a
 * set from them, corrects it while nobody has confirmed it, and the owner
 * confirms it — saying who checked the figures — before any run uses it. A
 * confirmed set never changes; a correction is a new set from a later month.
 */
export function PayrollRulesScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const access = usePayrollAccess();
  const [editing, setEditing] = useState<{ set: PayrollRuleSet | null } | null>(null);
  const [confirming, setConfirming] = useState<PayrollRuleSet | null>(null);
  const [removing, setRemoving] = useState<PayrollRuleSet | null>(null);

  const list = useQuery({
    queryKey: keys.payrollRuleSets,
    queryFn: async () => (await client.GET('/v1/payroll/rule-sets')).data!,
    enabled: access.run,
  });
  const done = async () => {
    setEditing(null);
    setConfirming(null);
    setRemoving(null);
    await queries.invalidateQueries({ queryKey: keys.payrollRuleSets });
  };

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('payroll.rules.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('payroll.rules.intro')}</p>
      </div>
      {list.data !== undefined && editing === null ? (
        <button
          type="button"
          className={buttonClass.primary}
          onClick={() => setEditing({ set: null })}
        >
          {t('payroll.rules.add')}
        </button>
      ) : null}
    </header>
  );

  if (access.loaded && !access.run) {
    return (
      <div className="flex flex-col gap-6 text-start">
        <DashboardBackLink />
        {header}
        <Notice>
          <p>{access.enabled ? t('payroll.rules.notAllowed') : t('errors.featureDisabled')}</p>
        </Notice>
      </div>
    );
  }

  if (editing !== null && list.data !== undefined) {
    return (
      <RuleSetEditor
        set={editing.set}
        seed={list.data.seed}
        onCancel={() => setEditing(null)}
        onSaved={done}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.payRuns} label={t('payroll.rules.back')} />
      {header}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <PayrollFailure error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <Disclaimer
            text={disclaimerText(list.data.disclaimer, locale, t('payroll.disclaimer'))}
          />
          {list.data.items.length === 0 ? (
            <Notice>
              <p>{t('payroll.rules.empty')}</p>
            </Notice>
          ) : (
            <ul className="flex flex-col gap-4">
              {list.data.items.map((set) => (
                <li key={set.id} className={cardClass}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <h2 className="text-base font-semibold text-content" dir="auto">
                        {set.name}
                      </h2>
                      <p className="text-sm text-content-muted">
                        {t('payroll.rules.from', { month: formatMonth(set.effectiveFrom, locale) })}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {set.can.edit ? (
                        <button
                          type="button"
                          className={buttonClass.secondary}
                          aria-label={t('payroll.rules.editLabel', { name: set.name })}
                          onClick={() => setEditing({ set })}
                        >
                          {t('payroll.rules.edit')}
                        </button>
                      ) : null}
                      {set.can.confirm ? (
                        <button
                          type="button"
                          className={buttonClass.primary}
                          aria-label={t('payroll.rules.confirmLabel', { name: set.name })}
                          onClick={() => setConfirming(set)}
                        >
                          {t('payroll.rules.confirm')}
                        </button>
                      ) : null}
                      {set.can.remove ? (
                        <button
                          type="button"
                          className={buttonClass.danger}
                          aria-label={t('payroll.rules.removeLabel', { name: set.name })}
                          onClick={() => setRemoving(set)}
                        >
                          {t('payroll.rules.remove')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {set.confirmed === null ? (
                    <p className="rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-content">
                      {set.can.confirm
                        ? t('payroll.rules.waitingForYou')
                        : t('payroll.rules.waitingForOwner')}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1 rounded-md border border-success bg-success-subtle px-3 py-2 text-sm text-content">
                      <p>
                        {t('payroll.rules.confirmedBy', {
                          name: set.confirmed.by.name,
                          when: formatDateTime(set.confirmed.at, { locale }),
                        })}
                      </p>
                      <p dir="auto" className="whitespace-pre-line">
                        {set.confirmed.note}
                      </p>
                    </div>
                  )}
                  <details className="text-sm">
                    <summary className="cursor-pointer text-accent">
                      {t('payroll.rules.showFigures')}
                    </summary>
                    <div className="pt-3">
                      <RuleFigures rules={set.rules} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {confirming === null ? null : (
        <ConfirmDialog set={confirming} onClose={() => setConfirming(null)} onDone={done} />
      )}
      {removing === null ? null : (
        <RemoveDialog set={removing} onClose={() => setRemoving(null)} onDone={done} />
      )}
    </div>
  );
}

/** A set's figures, to read: the bands, the high-income tiers, insurance and the fund. */
function RuleFigures({ rules }: { rules: PayrollRules }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const percent = (value: string) =>
    t('payroll.rules.percent', { rate: formatQuantity(value, locale) });
  const amount = (value: string) => <Amount value={value} currency={null} />;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {(
          [
            ['personalExemption', amount(rules.personalExemption)],
            ['siEmployeeRate', percent(rules.siEmployeeRate)],
            ['siEmployerRate', percent(rules.siEmployerRate)],
            ['siMinWage', amount(rules.siMinWage)],
            ['siMaxWage', amount(rules.siMaxWage)],
            ['martyrsFundRate', percent(rules.martyrsFundRate)],
          ] as const
        ).map(([field, value]) => (
          <div key={field} className="flex flex-col">
            <dt className="text-content-muted">{t(`payroll.rules.field.${field}`)}</dt>
            <dd className="text-content">{value}</dd>
          </div>
        ))}
      </dl>
      <BandsTable bands={rules.bands} caption={t('payroll.rules.bands')} />
      {rules.tiers.map((tier, index) => (
        <BandsTable
          key={tier.above}
          bands={tier.bands}
          caption={t('payroll.rules.tierCaption', {
            tier: index + 1,
            above: formatQuantity(tier.above, locale),
          })}
        />
      ))}
    </div>
  );
}

function BandsTable({ bands, caption }: { bands: readonly TaxBand[]; caption: string }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  return (
    <table className="w-full max-w-md text-sm">
      <caption className="pb-1 text-start font-medium text-content">{caption}</caption>
      <thead className="text-xs text-content-muted">
        <tr>
          <th scope="col" className="py-1 text-start font-medium">
            {t('payroll.rules.upTo')}
          </th>
          <th scope="col" className="py-1 text-end font-medium">
            {t('payroll.rules.rate')}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border-subtle">
        {bands.map((band, index) => (
          <tr key={`${band.upTo ?? 'top'}-${index}`}>
            <td className="py-1 tabular-nums">
              {band.upTo === null ? t('payroll.rules.andAbove') : formatQuantity(band.upTo, locale)}
            </td>
            <td className="py-1 text-end tabular-nums">
              {t('payroll.rules.percent', { rate: formatQuantity(band.rate, locale) })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

interface BandDraft {
  upTo: string;
  rate: string;
}

interface RulesDraft {
  personalExemption: string;
  bands: BandDraft[];
  tiers: { above: string; bands: BandDraft[] }[];
  siEmployeeRate: string;
  siEmployerRate: string;
  siMinWage: string;
  siMaxWage: string;
  martyrsFundRate: string;
}

/** The single figures of a set, beside its bands and tiers. */
type ScalarField =
  | 'personalExemption'
  | 'siEmployeeRate'
  | 'siEmployerRate'
  | 'siMinWage'
  | 'siMaxWage'
  | 'martyrsFundRate';
const PERCENT_FIELDS: ReadonlySet<string> = new Set([
  'rate',
  'siEmployeeRate',
  'siEmployerRate',
  'martyrsFundRate',
]);

const toBandDrafts = (bands: readonly TaxBand[]): BandDraft[] =>
  bands.map((band) => ({ upTo: band.upTo ?? '', rate: band.rate }));

function toDraft(rules: PayrollRules): RulesDraft {
  return {
    personalExemption: rules.personalExemption,
    bands: toBandDrafts(rules.bands),
    tiers: rules.tiers.map((tier) => ({ above: tier.above, bands: toBandDrafts(tier.bands) })),
    siEmployeeRate: rules.siEmployeeRate,
    siEmployerRate: rules.siEmployerRate,
    siMinWage: rules.siMinWage,
    siMaxWage: rules.siMaxWage,
    martyrsFundRate: rules.martyrsFundRate,
  };
}

/** The last band is always the open one, whatever was typed in it. */
const fromBandDrafts = (bands: readonly BandDraft[]): TaxBand[] =>
  bands.map((band, index) => ({
    upTo: index === bands.length - 1 || band.upTo.trim() === '' ? null : band.upTo.trim(),
    rate: band.rate.trim(),
  }));

function fromDraft(draft: RulesDraft): PayrollRules {
  return {
    personalExemption: draft.personalExemption.trim(),
    bands: fromBandDrafts(draft.bands),
    tiers: draft.tiers.map((tier) => ({
      above: tier.above.trim(),
      bands: fromBandDrafts(tier.bands),
    })),
    siEmployeeRate: draft.siEmployeeRate.trim(),
    siEmployerRate: draft.siEmployerRate.trim(),
    siMinWage: draft.siMinWage.trim(),
    siMaxWage: draft.siMaxWage.trim(),
    martyrsFundRate: draft.martyrsFundRate.trim(),
  };
}

interface Problem {
  path: string;
  message: string;
}

/** What the core's schema found wrong, where and what, in this language. */
function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string }[],
  t: TFunction,
): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const issue of issues) {
    const path = issue.path.map(String);
    const key = path.join('.');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const [head, a, b, c] = path;
    const last = path.at(-1) ?? '';
    let where: string;
    if (head === 'bands') {
      where =
        a === undefined
          ? t('payroll.rules.bands')
          : t('payroll.rules.where.band', { row: Number(a) + 1 });
    } else if (head === 'tiers') {
      const tier = Number(a) + 1;
      where =
        a === undefined
          ? t('payroll.rules.tiers')
          : b === 'above'
            ? t('payroll.rules.where.tier', { tier })
            : c === undefined
              ? t('payroll.rules.where.tierBands', { tier })
              : t('payroll.rules.where.tierBand', { tier, row: Number(c) + 1 });
    } else {
      where = t(`payroll.rules.field.${head as ScalarField}`);
    }
    const what =
      last === 'bands' || last === 'tiers'
        ? issue.code === 'too_small'
          ? t('payroll.rules.invalid.noBands')
          : issue.code === 'too_big'
            ? t('payroll.rules.invalid.tooMany')
            : t('payroll.rules.invalid.order')
        : PERCENT_FIELDS.has(last)
          ? t('payroll.rules.invalid.percent')
          : t('payroll.rules.invalid.amount');
    problems.push({ path: key, message: t('payroll.rules.invalid.at', { where, what }) });
  }
  return problems;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

function RuleSetEditor({
  set,
  seed,
  onCancel,
  onSaved,
}: {
  set: PayrollRuleSet | null;
  seed: { name: string; effectiveFrom: string; rules: PayrollRules };
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const start = set ?? seed;
  const [name, setName] = useState(set === null ? seed.name : set.name);
  const [month, setMonth] = useState(start.effectiveFrom.slice(0, 7));
  const [draft, setDraft] = useState<RulesDraft>(() => toDraft(start.rules));
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const invalid = new Set(problems?.map((problem) => problem.path));

  const save = useMutation({
    mutationFn: async (rules: PayrollRules) => {
      const effectiveFrom = `${month}-01`;
      if (set === null) {
        await client.POST('/v1/payroll/rule-sets', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { name: name.trim(), effectiveFrom, rules },
        });
      } else {
        await client.PATCH('/v1/payroll/rule-sets/{ruleSetId}', {
          params: { path: { ruleSetId: set.id } },
          body: { expectedVersion: set.version, name: name.trim(), effectiveFrom, rules },
        });
      }
    },
    onSuccess: onSaved,
  });

  const submit = () => {
    const found: Problem[] = [];
    if (name.trim() === '') {
      found.push({ path: 'name', message: t('payroll.rules.nameRequired') });
    }
    if (!MONTH.test(month)) {
      found.push({ path: 'month', message: t('payroll.rules.monthRequired') });
    }
    const candidate = fromDraft(draft);
    const parsed = payrollRulesSchema.safeParse(candidate);
    if (!parsed.success) {
      found.push(...describeIssues(parsed.error.issues, t));
    }
    setProblems(found);
    if (found.length === 0 && parsed.success) {
      save.mutate(parsed.data);
    }
  };

  const scalar = (field: ScalarField) => (
    <Field key={field} label={t(`payroll.rules.field.${field}`)}>
      {(id) => (
        <input
          id={id}
          type="text"
          inputMode="decimal"
          dir="ltr"
          aria-invalid={invalid.has(field)}
          className={inputClass}
          value={draft[field]}
          onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
        />
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      <button type="button" className={`${buttonClass.ghost} self-start`} onClick={onCancel}>
        {t('payroll.rules.backToList')}
      </button>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">
          {set === null
            ? t('payroll.rules.newTitle')
            : t('payroll.rules.editTitle', { name: set.name })}
        </h1>
        <p className="max-w-prose text-sm text-content-muted">
          {set === null ? t('payroll.rules.seedIntro') : t('payroll.rules.editIntro')}
        </p>
      </header>

      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <section aria-labelledby="rules-about" className={cardClass}>
          <h2 id="rules-about" className="text-base font-semibold text-content">
            {t('payroll.rules.about')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('payroll.rules.name')}>
              {(id) => (
                <input
                  id={id}
                  type="text"
                  dir="auto"
                  required
                  maxLength={200}
                  aria-invalid={invalid.has('name')}
                  className={inputClass}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('payroll.rules.effectiveFrom')} hint={t('payroll.rules.effectiveHint')}>
              {(id, describedBy) => (
                <input
                  id={id}
                  type="month"
                  dir="ltr"
                  required
                  aria-describedby={describedBy}
                  aria-invalid={invalid.has('month')}
                  className={inputClass}
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                />
              )}
            </Field>
          </div>
        </section>

        <section aria-labelledby="rules-tax" className={cardClass}>
          <h2 id="rules-tax" className="text-base font-semibold text-content">
            {t('payroll.rules.incomeTax')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.rules.bandsIntro')}</p>
          <div className="max-w-xs">{scalar('personalExemption')}</div>
          <BandsEditor
            legend={t('payroll.rules.bands')}
            prefix="bands"
            bands={draft.bands}
            invalid={invalid}
            onChange={(bands) => setDraft({ ...draft, bands })}
          />
        </section>

        <section aria-labelledby="rules-tiers" className={cardClass}>
          <h2 id="rules-tiers" className="text-base font-semibold text-content">
            {t('payroll.rules.tiers')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.rules.tiersIntro')}</p>
          {draft.tiers.map((tier, index) => {
            const number = index + 1;
            const setTier = (next: Partial<RulesDraft['tiers'][number]>) =>
              setDraft({
                ...draft,
                tiers: draft.tiers.map((candidate, at) =>
                  at === index ? { ...candidate, ...next } : candidate,
                ),
              });
            return (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
              >
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <Field label={t('payroll.rules.tierAbove', { tier: number })}>
                    {(id) => (
                      <input
                        id={id}
                        type="text"
                        inputMode="decimal"
                        dir="ltr"
                        aria-invalid={invalid.has(`tiers.${index}.above`)}
                        className={inputClass}
                        value={tier.above}
                        onChange={(event) => setTier({ above: event.target.value })}
                      />
                    )}
                  </Field>
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() =>
                      setDraft({ ...draft, tiers: draft.tiers.filter((_, at) => at !== index) })
                    }
                  >
                    {t('payroll.rules.removeTier', { tier: number })}
                  </button>
                </div>
                <BandsEditor
                  legend={t('payroll.rules.tierBands', { tier: number })}
                  prefix={`tiers.${index}.bands`}
                  bands={tier.bands}
                  invalid={invalid}
                  onChange={(bands) => setTier({ bands })}
                />
              </div>
            );
          })}
          <div>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={draft.tiers.length >= 10}
              onClick={() =>
                setDraft({
                  ...draft,
                  tiers: [...draft.tiers, { above: '', bands: draft.bands.map((b) => ({ ...b })) }],
                })
              }
            >
              {t('payroll.rules.addTier')}
            </button>
          </div>
        </section>

        <section aria-labelledby="rules-insurance" className={cardClass}>
          <h2 id="rules-insurance" className="text-base font-semibold text-content">
            {t('payroll.rules.insurance')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.rules.insuranceIntro')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {scalar('siEmployeeRate')}
            {scalar('siEmployerRate')}
            {scalar('siMinWage')}
            {scalar('siMaxWage')}
          </div>
        </section>

        <section aria-labelledby="rules-fund" className={cardClass}>
          <h2 id="rules-fund" className="text-base font-semibold text-content">
            {t('payroll.rules.fund')}
          </h2>
          <p className="text-sm text-content-muted">{t('payroll.rules.fundIntro')}</p>
          <div className="max-w-xs">{scalar('martyrsFundRate')}</div>
        </section>

        {problems !== null && problems.length > 0 ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
          >
            <p className="font-medium">{t('payroll.rules.problems')}</p>
            <ul className="list-disc ps-5">
              {problems.map((problem) => (
                <li key={problem.path}>{problem.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {save.isError ? <PayrollFailure error={save.error} /> : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass.primary} disabled={save.isPending}>
            {save.isPending
              ? t('payroll.saving')
              : set === null
                ? t('payroll.rules.create')
                : t('payroll.rules.saveChanges')}
          </button>
          <button type="button" className={buttonClass.secondary} onClick={onCancel}>
            {t('payroll.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** One table of bands: each band's top and rate; the last has no top. */
function BandsEditor({
  legend,
  prefix,
  bands,
  invalid,
  onChange,
}: {
  legend: string;
  prefix: string;
  bands: readonly BandDraft[];
  invalid: ReadonlySet<string>;
  onChange: (next: BandDraft[]) => void;
}) {
  const { t } = useTranslation();
  const set = (index: number, change: Partial<BandDraft>) =>
    onChange(bands.map((band, at) => (at === index ? { ...band, ...change } : band)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium text-content">{legend}</legend>
      <table className="w-full max-w-lg text-sm">
        <thead className="text-xs text-content-muted">
          <tr>
            <th scope="col" className="py-1 text-start font-medium">
              {t('payroll.rules.band')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('payroll.rules.upTo')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('payroll.rules.rate')}
            </th>
            <th scope="col" className="py-1">
              <span className="sr-only">{t('payroll.rules.bandActions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {bands.map((band, index) => {
            const row = index + 1;
            const last = index === bands.length - 1;
            return (
              <tr key={index}>
                <td className="py-1 pe-2 tabular-nums text-content-muted">{row}</td>
                <td className="py-1 pe-2">
                  {last ? (
                    <span className="text-content-muted">{t('payroll.rules.andAbove')}</span>
                  ) : (
                    <input
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      aria-label={t('payroll.rules.upToLabel', { legend, row })}
                      aria-invalid={invalid.has(`${prefix}.${index}.upTo`)}
                      className={inputClass}
                      value={band.upTo}
                      onChange={(event) => set(index, { upTo: event.target.value })}
                    />
                  )}
                </td>
                <td className="py-1 pe-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    dir="ltr"
                    aria-label={t('payroll.rules.rateLabel', { legend, row })}
                    aria-invalid={invalid.has(`${prefix}.${index}.rate`)}
                    className={`${inputClass} w-24`}
                    value={band.rate}
                    onChange={(event) => set(index, { rate: event.target.value })}
                  />
                </td>
                <td className="py-1 text-end">
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    disabled={bands.length <= 1}
                    aria-label={t('payroll.rules.removeBandLabel', { legend, row })}
                    onClick={() => onChange(bands.filter((_, at) => at !== index))}
                  >
                    {t('payroll.rules.removeBand')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={bands.length >= 20}
          onClick={() =>
            // A new band goes before the open one at the top.
            onChange([...bands.slice(0, -1), { upTo: '', rate: '' }, ...bands.slice(-1)])
          }
        >
          {t('payroll.rules.addBand')}
        </button>
      </div>
    </fieldset>
  );
}

/** The owner confirms, saying who checked the figures and against what. */
function ConfirmDialog({
  set,
  onClose,
  onDone,
}: {
  set: PayrollRuleSet;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const missing = note.trim() === '';
  const confirm = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/payroll/rule-sets/{ruleSetId}/confirm', {
          params: { path: { ruleSetId: set.id } },
          body: { expectedVersion: set.version, note: note.trim() },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('payroll.rules.confirmTitle', { name: set.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('payroll.cancel')}
          </button>
          <button
            type="submit"
            form="payroll-confirm-rules"
            className={buttonClass.primary}
            disabled={confirm.isPending}
          >
            {confirm.isPending ? t('payroll.rules.confirming') : t('payroll.rules.confirm')}
          </button>
        </>
      }
    >
      <form
        id="payroll-confirm-rules"
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!missing) {
            confirm.mutate();
          }
        }}
      >
        <p>{t('payroll.rules.confirmIntro', { month: formatMonth(set.effectiveFrom, locale) })}</p>
        <Field
          label={t('payroll.rules.confirmNote')}
          hint={
            tried && missing
              ? t('payroll.rules.confirmNoteRequired')
              : t('payroll.rules.confirmNoteHint')
          }
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={3}
              dir="auto"
              required
              maxLength={1000}
              aria-describedby={describedBy}
              aria-invalid={tried && missing}
              className={inputClass}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        {confirm.isError ? <PayrollFailure error={confirm.error} /> : null}
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  set,
  onClose,
  onDone,
}: {
  set: PayrollRuleSet;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const remove = useMutation({
    mutationFn: async () => {
      await client.DELETE('/v1/payroll/rule-sets/{ruleSetId}', {
        params: { path: { ruleSetId: set.id } },
      });
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('payroll.rules.removeTitle', { name: set.name })}
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
            {remove.isPending ? t('payroll.rules.removing') : t('payroll.rules.remove')}
          </button>
        </>
      }
    >
      <p>{t('payroll.rules.removeIntro')}</p>
      {remove.isError ? <PayrollFailure error={remove.error} /> : null}
    </Dialog>
  );
}
