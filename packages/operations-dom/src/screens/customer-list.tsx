import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { keys, useOperations } from '../api.js';
import { addressText, buttonClass, Dialog, Failure, Field, inputClass, Loading } from '../ui.js';
import {
  CustomerFields,
  emptyCustomer,
  toCustomerBody,
  type CustomerDraft,
} from './customer-fields.js';

type Status = 'active' | 'on_hold' | 'closed';

/** Customers, alphabetically: found by any word of their details, a status or a tag. */
export function CustomerListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [tag, setTag] = useState('');
  const [applied, setApplied] = useState<{ q: string; status: Status | ''; tag: string }>({
    q: '',
    status: '',
    tag: '',
  });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CustomerDraft>(emptyCustomer);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const tags = useQuery({
    queryKey: keys.tags,
    queryFn: async () => (await client.GET('/v1/customer-tags')).data!.items,
  });
  const query = {
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.status === '' ? {} : { status: [applied.status] }),
    ...(applied.tag === '' ? {} : { tag: [applied.tag] }),
  };
  const list = useInfiniteQuery({
    queryKey: keys.customers(query),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/customers', {
          params: {
            query: {
              ...query,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: 50,
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/customers', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: toCustomerBody(draft),
        })
      ).data!,
    onSuccess: (customer) => navigate(paths.customer(customer.id)),
  });

  const manage = me.data?.permissions.includes('customer.manage') ?? false;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-6 text-start">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('operations.customers.title')}</h1>
        {manage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => {
              setDraft(emptyCustomer);
              setCreating(true);
            }}
          >
            {t('operations.customers.new')}
          </button>
        ) : null}
      </header>

      <form
        aria-label={t('operations.customers.title')}
        className="grid gap-3 rounded-lg border border-border-subtle bg-surface p-4 sm:grid-cols-4 sm:items-end"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setApplied({ q, status, tag });
        }}
      >
        <Field label={t('operations.customers.search')} className="sm:col-span-2">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.customers.status.label')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as Status | '')}
            >
              <option value="">{t('operations.customers.status.any')}</option>
              {(['active', 'on_hold', 'closed'] as const).map((option) => (
                <option key={option} value={option}>
                  {t(`operations.customers.status.${option}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.customers.tag')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">{t('operations.customers.anyTag')}</option>
              {tags.data?.map((entry) => (
                <option key={entry.tag} value={entry.tag}>
                  {entry.tag} ({entry.customers})
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="sm:col-span-4">
          <button type="submit" className={buttonClass.primary}>
            {t('operations.workOrders.apply')}
          </button>
        </div>
      </form>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('operations.customers.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {items.map((customer) => (
            <li
              key={customer.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <div className="flex flex-col">
                <a
                  href={paths.customer(customer.id)}
                  className="font-medium text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.customer(customer.id));
                  }}
                >
                  {customer.name}
                </a>
                <span className="text-xs text-content-muted">
                  {[customer.accountNumber, addressText(customer.address), customer.phone]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {customer.status === 'active' ? null : (
                  <span className="rounded-full border border-warning bg-warning-subtle px-2 text-xs text-content">
                    {t(`operations.customers.status.${customer.status}`)}
                  </span>
                )}
                {customer.tags.map((entry) => (
                  <span
                    key={entry}
                    className="rounded-full border border-border-subtle px-2 text-xs text-content-muted"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {list.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          onClick={() => void list.fetchNextPage()}
        >
          {t('operations.customers.more')}
        </button>
      ) : null}

      {creating ? (
        <Dialog
          wide
          title={t('operations.customers.new')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setCreating(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                form="new-customer"
                className={buttonClass.primary}
                disabled={draft.name.trim() === '' || create.isPending}
                aria-busy={create.isPending}
              >
                {t('operations.customer.create')}
              </button>
            </>
          }
        >
          <form
            id="new-customer"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <CustomerFields value={draft} onChange={setDraft} />
          </form>
          {create.isError ? <Failure error={create.error} /> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
