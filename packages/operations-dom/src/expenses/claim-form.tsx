import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { type ExpenseClaimDetail, keys, useOperations } from '../api.js';
import { AMOUNT_PATTERN, AppLink, isAmount } from '../ledger/ledger-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  ExpenseFailure,
  localToday,
  Notice,
  RECEIPT_ACCEPT,
  useCompanyCurrency,
  useExpenseAccess,
  useExpenseCategories,
  useReceipts,
} from './expense-parts.js';

interface Draft {
  categoryId: string;
  spentOn: string;
  amount: string;
  description: string;
  workOrderId: string;
}

/** A receipt chosen with the form, and how sending it went once the claim exists. */
interface Chosen {
  key: string;
  file: File;
  state: 'waiting' | 'sending' | 'sent' | 'failed';
}

/**
 * Claiming an expense back (ADR-0010): what it was for, the day it was spent
 * — today or earlier — the amount in the company's currency, a description,
 * and the job it was for if any. Receipts chosen here are sent once the claim
 * exists; one that does not arrive can be added again from the claim, which
 * is never submitted twice.
 */
export function NewExpenseClaimScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const access = useExpenseAccess();
  const categories = useExpenseCategories();
  const currency = useCompanyCurrency();
  const receipts = useReceipts();
  const fileId = useId();
  const [today] = useState(localToday);
  const [draft, setDraft] = useState<Draft>({
    categoryId: '',
    spentOn: today,
    amount: '',
    description: '',
    workOrderId: '',
  });
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [tried, setTried] = useState(false);
  const [created, setCreated] = useState<ExpenseClaimDetail | null>(null);
  // One key for this claim, however many times the button is pressed.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const jobs = useQuery({
    queryKey: keys.myRecentJobs,
    queryFn: async () =>
      (
        await client.GET('/v1/work-orders', {
          params: { query: { assigneeId: 'me', order: 'created', limit: 50 } },
        })
      ).data!.items,
    enabled: access.submit,
    retry: false,
  });

  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const problems = {
    categoryId: draft.categoryId === '' ? t('expenses.form.categoryRequired') : null,
    spentOn:
      draft.spentOn === ''
        ? t('expenses.form.spentOnRequired')
        : draft.spentOn > today
          ? t('apiErrors.spent_in_future')
          : null,
    amount: isAmount(draft.amount) ? null : t('expenses.form.amountInvalid'),
    description: draft.description.trim() === '' ? t('expenses.form.descriptionRequired') : null,
  };
  const ready = Object.values(problems).every((problem) => problem === null);

  const sendReceipts = async (claim: ExpenseClaimDetail, files: readonly Chosen[]) => {
    let failed = 0;
    for (const entry of files) {
      setChosen((all) =>
        all.map((item) => (item.key === entry.key ? { ...item, state: 'sending' } : item)),
      );
      try {
        await receipts.attach(claim.id, entry.file);
        setChosen((all) =>
          all.map((item) => (item.key === entry.key ? { ...item, state: 'sent' } : item)),
        );
      } catch {
        failed += 1;
        setChosen((all) =>
          all.map((item) => (item.key === entry.key ? { ...item, state: 'failed' } : item)),
        );
      }
    }
    await queries.invalidateQueries({ queryKey: ['expenses'] });
    if (failed === 0) {
      navigate(paths.expenseClaim(claim.id));
    }
  };

  const submit = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            categoryId: draft.categoryId,
            spentOn: draft.spentOn,
            amount: draft.amount.trim(),
            description: draft.description.trim(),
            ...(draft.workOrderId === '' ? {} : { workOrderId: draft.workOrderId }),
          },
        })
      ).data!,
    onSuccess: async (claim) => {
      setCreated(claim);
      queries.setQueryData(keys.expenseClaim(claim.id), claim);
      await sendReceipts(claim, chosen);
    },
  });

  const back = <BackLink to={paths.myExpenseClaims} label={t('expenses.form.back')} />;
  if (categories.isPending || !access.loaded) {
    return <Loading />;
  }
  if (categories.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <ExpenseFailure error={categories.error} onRetry={() => void categories.refetch()} />
      </div>
    );
  }
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-content">{t('expenses.form.title')}</h1>
      <p className="text-sm text-content-muted">{t('expenses.form.intro')}</p>
    </header>
  );
  if (!access.submit) {
    return (
      <div className="flex flex-col gap-6 text-start">
        {back}
        {header}
        <Notice>
          <p>{access.enabled ? t('errors.forbidden') : t('errors.featureDisabled')}</p>
        </Notice>
      </div>
    );
  }
  if (categories.data.length === 0) {
    return (
      <div className="flex flex-col gap-6 text-start">
        {back}
        {header}
        <Notice>
          <p>{t('expenses.form.noCategories')}</p>
          {access.approve ? (
            <AppLink to={paths.expenseCategories}>{t('expenses.form.addCategories')}</AppLink>
          ) : null}
        </Notice>
      </div>
    );
  }

  const locked = created !== null || submit.isPending;
  const failedFiles = chosen.filter((entry) => entry.state === 'failed');
  const sending = chosen.some((entry) => entry.state === 'sending');
  const shown = (problem: string | null) => (tried && problem !== null ? problem : undefined);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      {header}

      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (ready && !locked) {
            submit.mutate();
          }
        }}
      >
        <section aria-labelledby="expense-what" className={cardClass}>
          <h2 id="expense-what" className="text-lg font-semibold text-content">
            {t('expenses.form.what')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('expenses.field.category')}
              {...(shown(problems.categoryId) === undefined
                ? {}
                : { hint: shown(problems.categoryId)! })}
            >
              {(id, describedBy) => (
                <select
                  id={id}
                  required
                  disabled={locked}
                  aria-describedby={describedBy}
                  aria-invalid={shown(problems.categoryId) !== undefined}
                  className={inputClass}
                  value={draft.categoryId}
                  onChange={(event) => set({ categoryId: event.target.value })}
                >
                  <option value="">{t('expenses.form.chooseCategory')}</option>
                  {categories.data.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label={t('expenses.field.spentOn')}
              hint={shown(problems.spentOn) ?? t('expenses.form.spentOnHint')}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  type="date"
                  dir="ltr"
                  required
                  max={today}
                  disabled={locked}
                  aria-describedby={describedBy}
                  aria-invalid={shown(problems.spentOn) !== undefined}
                  className={inputClass}
                  value={draft.spentOn}
                  onChange={(event) => set({ spentOn: event.target.value })}
                />
              )}
            </Field>
            <Field
              label={
                currency === null
                  ? t('expenses.field.amount')
                  : t('expenses.form.amountIn', { currency })
              }
              hint={shown(problems.amount) ?? t('expenses.form.amountHint')}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  inputMode="decimal"
                  dir="ltr"
                  required
                  pattern={AMOUNT_PATTERN}
                  disabled={locked}
                  aria-describedby={describedBy}
                  aria-invalid={shown(problems.amount) !== undefined}
                  className={inputClass}
                  value={draft.amount}
                  onChange={(event) => set({ amount: event.target.value.trim() })}
                />
              )}
            </Field>
            {jobs.isSuccess && jobs.data.length > 0 ? (
              <Field label={t('expenses.field.workOrder')} hint={t('expenses.form.workOrderHint')}>
                {(id, describedBy) => (
                  <select
                    id={id}
                    disabled={locked}
                    aria-describedby={describedBy}
                    className={inputClass}
                    value={draft.workOrderId}
                    onChange={(event) => set({ workOrderId: event.target.value })}
                  >
                    <option value="">{t('expenses.form.noWorkOrder')}</option>
                    {jobs.data.map((job) => (
                      <option key={job.id} value={job.id}>
                        {`${job.referenceLabel} · ${job.title}`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            <Field
              label={t('expenses.field.description')}
              className="sm:col-span-2"
              {...(shown(problems.description) === undefined
                ? { hint: t('expenses.form.descriptionHint') }
                : { hint: shown(problems.description)! })}
            >
              {(id, describedBy) => (
                <textarea
                  id={id}
                  rows={3}
                  dir="auto"
                  required
                  maxLength={1000}
                  disabled={locked}
                  aria-describedby={describedBy}
                  aria-invalid={shown(problems.description) !== undefined}
                  className={inputClass}
                  value={draft.description}
                  onChange={(event) => set({ description: event.target.value })}
                />
              )}
            </Field>
          </div>
        </section>

        <section aria-labelledby="expense-receipts" className={cardClass}>
          <h2 id="expense-receipts" className="text-lg font-semibold text-content">
            {t('expenses.receipts.title')}
          </h2>
          <p className="text-sm text-content-muted">{t('expenses.form.receiptsIntro')}</p>
          {created === null ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={fileId} className="text-sm font-medium text-content">
                {t('expenses.receipts.choose')}
              </label>
              <input
                id={fileId}
                type="file"
                multiple
                accept={RECEIPT_ACCEPT}
                disabled={locked}
                className="text-sm text-content"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  setChosen((all) => [
                    ...all,
                    ...files.map((file) => ({
                      key: crypto.randomUUID(),
                      file,
                      state: 'waiting' as const,
                    })),
                  ]);
                  event.target.value = '';
                }}
              />
            </div>
          ) : null}
          {chosen.length === 0 ? (
            <p className="text-sm text-content-muted">{t('expenses.form.noReceipts')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {chosen.map((entry) => (
                <li key={entry.key} className="flex flex-wrap items-center gap-2">
                  <span dir="auto" className="text-content">
                    {entry.file.name}
                  </span>
                  {entry.state === 'waiting' ? null : (
                    <span className="text-content-muted">
                      {t(`expenses.form.receiptState.${entry.state}`)}
                    </span>
                  )}
                  {created === null && !locked ? (
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      aria-label={t('expenses.form.removeReceipt', { name: entry.file.name })}
                      onClick={() =>
                        setChosen((all) => all.filter((item) => item.key !== entry.key))
                      }
                    >
                      {t('expenses.form.remove')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {submit.isError ? <ExpenseFailure error={submit.error} /> : null}

        {created !== null && failedFiles.length > 0 && !sending ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
          >
            <p>
              {t('expenses.form.receiptsFailed', {
                reference: created.reference,
                count: failedFiles.length,
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => void sendReceipts(created, failedFiles)}
              >
                {t('expenses.form.retryReceipts')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => navigate(paths.expenseClaim(created.id))}
              >
                {t('expenses.form.openClaim', { reference: created.reference })}
              </button>
            </div>
          </div>
        ) : null}

        {created === null ? (
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass.primary} disabled={locked}>
              {submit.isPending ? t('expenses.form.submitting') : t('expenses.form.submit')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => navigate(paths.myExpenseClaims)}
            >
              {t('expenses.cancel')}
            </button>
          </div>
        ) : sending ? (
          <p role="status" className="text-sm text-content">
            {t('expenses.form.sendingReceipts', { reference: created.reference })}
          </p>
        ) : null}
      </form>
    </div>
  );
}
