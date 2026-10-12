import { ACCOUNT_TYPES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type AccountType, type LedgerAccount, useOperations } from '../api.js';
import { BackLink, buttonClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  LedgerFailure,
  ManagementNote,
  useLedgerAccess,
  useLedgerAccounts,
} from './ledger-parts.js';

/**
 * The chart of accounts (ADR-0009): every account by code, its type, the
 * automatic posting that uses it and whether it is archived. Owners and
 * admins add accounts and rename, recode, retype or archive them; the server
 * says when it will not — a type fixed by postings, an account a posting
 * uses, a code taken, or a change made elsewhere first.
 */
export function LedgerAccountsScreen() {
  const { t } = useTranslation();
  const { paths } = useOperations();
  const access = useLedgerAccess();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<LedgerAccount | 'new' | null>(null);
  const accounts = useLedgerAccounts(archived);

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.ledger} label={t('ledger.back')} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('ledger.accounts.title')}</h1>
          <p className="text-sm text-content-muted">{t('ledger.accounts.intro')}</p>
          <ManagementNote />
        </div>
        {access.manage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setEditing('new')}>
            {t('ledger.accounts.add')}
          </button>
        ) : null}
      </header>

      <label className="flex items-center gap-2 text-sm text-content">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => setArchived(event.target.checked)}
        />
        {t('ledger.accounts.showArchived')}
      </label>

      {accounts.isPending ? (
        <Loading />
      ) : accounts.isError ? (
        <LedgerFailure error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : accounts.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">{t('ledger.accounts.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('ledger.accounts.code')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('ledger.accounts.name')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('ledger.accounts.type')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('ledger.accounts.role')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('ledger.accounts.state')}
                </th>
                {access.manage ? (
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">{t('ledger.accounts.actions')}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {accounts.data.map((account) => (
                <tr key={account.id} className={account.archived ? 'text-content-muted' : ''}>
                  <td className="px-3 py-2 tabular-nums">
                    <span dir="ltr">{account.code}</span>
                  </td>
                  <td className="px-3 py-2 text-content">{account.name}</td>
                  <td className="px-3 py-2">{t(`ledger.accountType.${account.type}`)}</td>
                  <td className="px-3 py-2">
                    {account.role === null ? '' : t(`ledger.role.${account.role}`)}
                  </td>
                  <td className="px-3 py-2">
                    {account.archived ? t('ledger.accounts.archived') : t('ledger.accounts.inUse')}
                  </td>
                  {access.manage ? (
                    <td className="px-3 py-2 text-end">
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        aria-label={t('ledger.accounts.editOne', { code: account.code })}
                        onClick={() => setEditing(account)}
                      >
                        {t('ledger.accounts.edit')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing === null ? null : (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Adds an account, or changes one with the version it was read at. */
function AccountDialog({
  account,
  onClose,
}: {
  account: LedgerAccount | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const [code, setCode] = useState(account?.code ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'expense');
  const [archived, setArchived] = useState(account?.archived ?? false);
  const codeValid = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/u.test(code.trim());
  const valid = codeValid && name.trim() !== '';

  const save = useMutation({
    mutationFn: async () => {
      if (account === null) {
        return (
          await client.POST('/v1/ledger/accounts', {
            body: { code: code.trim(), name: name.trim(), type },
          })
        ).data!;
      }
      return (
        await client.PATCH('/v1/ledger/accounts/{accountId}', {
          params: { path: { accountId: account.id } },
          body: {
            expectedVersion: account.version,
            ...(code.trim() === account.code ? {} : { code: code.trim() }),
            ...(name.trim() === account.name ? {} : { name: name.trim() }),
            ...(type === account.type ? {} : { type }),
            ...(archived === account.archived ? {} : { archived }),
          },
        })
      ).data!;
    },
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      onClose();
    },
  });

  const formId = account === null ? 'ledger-account-new' : `ledger-account-${account.id}`;
  return (
    <Dialog
      title={account === null ? t('ledger.accounts.add') : t('ledger.accounts.editTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={!valid || save.isPending}
          >
            {save.isPending ? t('ledger.saving') : t('ledger.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            save.mutate();
          }
        }}
      >
        <Field label={t('ledger.accounts.code')} hint={t('ledger.accounts.codeHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              required
              dir="ltr"
              maxLength={20}
              aria-describedby={describedBy}
              aria-invalid={code !== '' && !codeValid}
              className={inputClass}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('ledger.accounts.name')}>
          {(id) => (
            <input
              id={id}
              required
              dir="auto"
              maxLength={200}
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('ledger.accounts.type')} hint={t('ledger.accounts.typeHint')}>
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={type}
              onChange={(event) => setType(event.target.value as AccountType)}
            >
              {ACCOUNT_TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`ledger.accountType.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {account === null ? null : (
          <>
            {account.role === null ? null : (
              <p className="text-sm text-content-muted">
                {t('ledger.accounts.usedBy', { role: t(`ledger.role.${account.role}`) })}
              </p>
            )}
            <label className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              {t('ledger.accounts.archive')}
            </label>
            <p className="text-xs text-content-muted">{t('ledger.accounts.archiveHint')}</p>
          </>
        )}
        {save.isError ? <LedgerFailure error={save.error} /> : null}
      </form>
    </Dialog>
  );
}
