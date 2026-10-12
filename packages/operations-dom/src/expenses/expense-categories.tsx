import { useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ExpenseCategory, type LedgerAccount, useOperations } from '../api.js';
import { AccountSelect, accountLabel, useLedgerAccounts } from '../ledger/ledger-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import { ExpenseFailure, Notice, useExpenseAccess, useExpenseCategories } from './expense-parts.js';

/**
 * What expenses may be claimed for (ADR-0010), kept by those who approve
 * claims: add one, rename it, point it at an expense account in the ledger —
 * where the ledger is on — or archive it so nobody claims under it any more.
 * Claims already made keep their category.
 */
export function ExpenseCategoriesScreen() {
  const { t } = useTranslation();
  const { client, paths } = useOperations();
  const queries = useQueryClient();
  const access = useExpenseAccess();
  const categories = useExpenseCategories(true, access.approve);
  const accounts = useLedgerAccounts(false, access.ledger);
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);

  const expenseAccounts = (accounts.data ?? []).filter((account) => account.type === 'expense');
  const refresh = () => queries.invalidateQueries({ queryKey: ['expenses', 'categories'] });

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses/categories', {
          body: { name: name.trim(), ...(accountId === '' ? {} : { accountId }) },
        })
      ).data!,
    onSuccess: async () => {
      setName('');
      setAccountId('');
      await refresh();
    },
  });
  const archive = useMutation({
    mutationFn: async (category: ExpenseCategory) =>
      (
        await client.PATCH('/v1/expenses/categories/{categoryId}', {
          params: { path: { categoryId: category.id } },
          body: { expectedVersion: category.version, archived: !category.archived },
        })
      ).data!,
    onSuccess: refresh,
  });

  const back = <BackLink to={paths.expenseClaims} label={t('expenses.categories.back')} />;
  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-content">{t('expenses.categories.title')}</h1>
      <p className="text-sm text-content-muted">{t('expenses.categories.intro')}</p>
    </header>
  );
  if (!access.loaded) {
    return <Loading />;
  }
  if (!access.approve) {
    return (
      <div className="flex flex-col gap-6 text-start">
        {back}
        {header}
        <Notice>
          <p>
            {access.enabled ? t('expenses.categories.notApprover') : t('errors.featureDisabled')}
          </p>
        </Notice>
      </div>
    );
  }

  const accountName = (id: string | null) => {
    if (id === null) {
      return t('expenses.categories.defaultAccount');
    }
    const account = accounts.data?.find((candidate) => candidate.id === id);
    return account === undefined ? '' : accountLabel(account);
  };
  const inUse = (categories.data ?? []).filter((category) => !category.archived);
  const archived = (categories.data ?? []).filter((category) => category.archived);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      {header}

      <section aria-labelledby="category-add" className={cardClass}>
        <h2 id="category-add" className="text-lg font-semibold text-content">
          {t('expenses.categories.add')}
        </h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') {
              create.mutate();
            }
          }}
        >
          <Field label={t('expenses.categories.name')} className="min-w-56 flex-1">
            {(id) => (
              <input
                id={id}
                required
                dir="auto"
                maxLength={100}
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          {access.ledger ? (
            <Field label={t('expenses.categories.account')} className="min-w-56 flex-1">
              {(id) => (
                <AccountSelect
                  id={id}
                  accounts={expenseAccounts}
                  value={accountId}
                  emptyLabel={t('expenses.categories.defaultAccount')}
                  onChange={setAccountId}
                />
              )}
            </Field>
          ) : null}
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={name.trim() === '' || create.isPending}
          >
            {create.isPending ? t('expenses.saving') : t('expenses.categories.addAction')}
          </button>
        </form>
        {access.ledger ? (
          <p className="text-sm text-content-muted">{t('expenses.categories.accountHint')}</p>
        ) : null}
        {create.isError ? <ExpenseFailure error={create.error} /> : null}
      </section>

      {categories.isPending ? (
        <Loading />
      ) : categories.isError ? (
        <ExpenseFailure error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <>
          <CategoryGroup
            id="categories-in-use"
            title={t('expenses.categories.inUse')}
            empty={t('expenses.categories.none')}
            categories={inUse}
            accountName={access.ledger ? accountName : undefined}
            busy={archive.isPending}
            onEdit={setEditing}
            onArchive={(category) => archive.mutate(category)}
          />
          {archived.length === 0 ? null : (
            <CategoryGroup
              id="categories-archived"
              title={t('expenses.categories.archived')}
              empty=""
              categories={archived}
              accountName={access.ledger ? accountName : undefined}
              busy={archive.isPending}
              onEdit={setEditing}
              onArchive={(category) => archive.mutate(category)}
            />
          )}
          {archive.isError ? <ExpenseFailure error={archive.error} /> : null}
        </>
      )}

      {editing === null ? null : (
        <EditDialog
          category={editing}
          accounts={access.ledger ? expenseAccounts : null}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function CategoryGroup({
  id,
  title,
  empty,
  categories,
  accountName,
  busy,
  onEdit,
  onArchive,
}: {
  id: string;
  title: string;
  empty: string;
  categories: readonly ExpenseCategory[];
  accountName: ((id: string | null) => string) | undefined;
  busy: boolean;
  onEdit: (category: ExpenseCategory) => void;
  onArchive: (category: ExpenseCategory) => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-semibold text-content">
        {title}
      </h2>
      {categories.length === 0 ? (
        <p className="text-sm text-content-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-content" dir="auto">
                  {category.name}
                </span>
                {accountName === undefined ? null : (
                  <span className="text-sm text-content-muted">
                    {t('expenses.categories.postsTo', { account: accountName(category.accountId) })}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass.ghost}
                  aria-label={t('expenses.categories.editLabel', { name: category.name })}
                  onClick={() => onEdit(category)}
                >
                  {t('expenses.categories.edit')}
                </button>
                <button
                  type="button"
                  className={buttonClass.ghost}
                  disabled={busy}
                  aria-label={t(
                    category.archived
                      ? 'expenses.categories.restoreLabel'
                      : 'expenses.categories.archiveLabel',
                    { name: category.name },
                  )}
                  onClick={() => onArchive(category)}
                >
                  {category.archived
                    ? t('expenses.categories.restore')
                    : t('expenses.categories.archive')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Renames a category, and where the ledger is on, changes the account it posts to. */
function EditDialog({
  category,
  accounts,
  onClose,
  onDone,
}: {
  category: ExpenseCategory;
  accounts: readonly LedgerAccount[] | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [name, setName] = useState(category.name);
  const [accountId, setAccountId] = useState(category.accountId ?? '');
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/expenses/categories/{categoryId}', {
          params: { path: { categoryId: category.id } },
          body: {
            expectedVersion: category.version,
            ...(name.trim() === category.name ? {} : { name: name.trim() }),
            ...(accounts === null || accountId === (category.accountId ?? '')
              ? {}
              : { accountId: accountId === '' ? null : accountId }),
          },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('expenses.categories.editTitle', { name: category.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('expenses.cancel')}
          </button>
          <button
            type="submit"
            form="expense-category-edit"
            className={buttonClass.primary}
            disabled={name.trim() === '' || save.isPending}
          >
            {save.isPending ? t('expenses.saving') : t('expenses.save')}
          </button>
        </>
      }
    >
      <form
        id="expense-category-edit"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') {
            save.mutate();
          }
        }}
      >
        <Field label={t('expenses.categories.name')}>
          {(id) => (
            <input
              id={id}
              required
              dir="auto"
              maxLength={100}
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {accounts === null ? null : (
          <Field label={t('expenses.categories.account')}>
            {(id) => (
              <AccountSelect
                id={id}
                accounts={accounts}
                value={accountId}
                emptyLabel={t('expenses.categories.defaultAccount')}
                onChange={setAccountId}
              />
            )}
          </Field>
        )}
        {save.isError ? <ExpenseFailure error={save.error} /> : null}
      </form>
    </Dialog>
  );
}
