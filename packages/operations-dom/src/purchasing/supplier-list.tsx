import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type Supplier, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import { SupplierStatusBadge } from './purchasing-parts.js';

/**
 * Who the company buys from (CRM/ERP plan, phase E2). Active suppliers
 * first; the inactive ones are kept on record and shown on request.
 */

export interface SupplierDraft {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  taxReference: string;
  paymentTerms: string;
  leadTimeDays: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postcode: string;
  countryCode: string;
  notes: string;
}

export const emptySupplierDraft: SupplierDraft = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  taxReference: '',
  paymentTerms: '',
  leadTimeDays: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postcode: '',
  countryCode: '',
  notes: '',
};

export function supplierDraftOf(supplier: Supplier): SupplierDraft {
  return {
    name: supplier.name,
    contactName: supplier.contactName ?? '',
    email: supplier.email ?? '',
    phone: supplier.phone ?? '',
    taxReference: supplier.taxReference ?? '',
    paymentTerms: supplier.paymentTerms ?? '',
    leadTimeDays: supplier.leadTimeDays === null ? '' : String(supplier.leadTimeDays),
    line1: supplier.address.line1 ?? '',
    line2: supplier.address.line2 ?? '',
    city: supplier.address.city ?? '',
    region: supplier.address.region ?? '',
    postcode: supplier.address.postcode ?? '',
    countryCode: supplier.address.countryCode ?? '',
    notes: supplier.notes ?? '',
  };
}

const orNull = (text: string) => (text.trim() === '' ? null : text.trim());

/** The request body a draft stands for. */
export function supplierBodyOf(draft: SupplierDraft) {
  return {
    name: draft.name.trim(),
    contactName: orNull(draft.contactName),
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    taxReference: orNull(draft.taxReference),
    paymentTerms: orNull(draft.paymentTerms),
    leadTimeDays: draft.leadTimeDays.trim() === '' ? null : Number(draft.leadTimeDays),
    address: {
      line1: orNull(draft.line1),
      line2: orNull(draft.line2),
      city: orNull(draft.city),
      region: orNull(draft.region),
      postcode: orNull(draft.postcode),
      countryCode: orNull(draft.countryCode)?.toUpperCase() ?? null,
    },
    notes: orNull(draft.notes),
  };
}

export const supplierDraftValid = (draft: SupplierDraft) =>
  draft.name.trim() !== '' &&
  (draft.leadTimeDays.trim() === '' || /^\d{1,4}$/u.test(draft.leadTimeDays.trim())) &&
  (draft.countryCode.trim() === '' || /^[A-Za-z]{2}$/u.test(draft.countryCode.trim()));

/** The supplier form, shared by the new-supplier dialog and the supplier screen. */
export function SupplierFields({
  draft,
  onChange,
}: {
  draft: SupplierDraft;
  onChange: (draft: SupplierDraft) => void;
}) {
  const { t } = useTranslation();
  const text = (
    key: keyof SupplierDraft,
    options: { type?: string; maxLength?: number; pattern?: string; dir?: 'ltr' } = {},
  ) => (
    <Field label={t(`purchasing.suppliers.fields.${key}`)}>
      {(id) => (
        <input
          id={id}
          type={options.type ?? 'text'}
          required={key === 'name'}
          maxLength={options.maxLength ?? 200}
          {...(options.pattern === undefined ? {} : { pattern: options.pattern })}
          {...(options.dir === undefined ? {} : { dir: options.dir })}
          className={inputClass}
          value={draft[key]}
          onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">{text('name')}</div>
      {text('contactName')}
      {text('email', { type: 'email', maxLength: 320, dir: 'ltr' })}
      {text('phone', { type: 'tel', maxLength: 40, dir: 'ltr' })}
      {text('taxReference', { maxLength: 64, dir: 'ltr' })}
      {text('paymentTerms')}
      {text('leadTimeDays', { pattern: String.raw`\d{1,4}`, maxLength: 4, dir: 'ltr' })}
      {text('line1')}
      {text('line2')}
      {text('city', { maxLength: 120 })}
      {text('region', { maxLength: 120 })}
      {text('postcode', { maxLength: 20, dir: 'ltr' })}
      {text('countryCode', { pattern: '[A-Za-z]{2}', maxLength: 2, dir: 'ltr' })}
      <Field label={t('purchasing.suppliers.fields.notes')} className="sm:col-span-2">
        {(id) => (
          <textarea
            id={id}
            rows={3}
            maxLength={10_000}
            className={inputClass}
            value={draft.notes}
            onChange={(event) => onChange({ ...draft, notes: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

export function SupplierListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const rowMenu = useRowMenu();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptySupplierDraft);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManage = me.data?.permissions.includes('purchasing.manage') ?? false;

  const query = {
    ...(searched === '' ? {} : { q: searched }),
    ...(includeInactive ? { status: ['active', 'inactive'] as ('active' | 'inactive')[] } : {}),
    limit: 50,
  };
  const suppliers = useInfiniteQuery({
    queryKey: keys.suppliers(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/purchasing/suppliers', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = suppliers.data?.pages.flatMap((page) => page.items) ?? [];

  const create = useMutation({
    mutationFn: async () =>
      (await client.POST('/v1/purchasing/suppliers', { body: supplierBodyOf(draft) })).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['purchasing'] });
      navigate(paths.supplier(created.id));
    },
  });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('purchasing.suppliers.title')}</h1>
        {canManage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => {
              create.reset();
              setDraft(emptySupplierDraft);
              setCreating(true);
            }}
          >
            {t('purchasing.suppliers.new')}
          </button>
        ) : null}
      </header>

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched(text.trim());
        }}
      >
        <Field label={t('purchasing.suppliers.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => setIncludeInactive(event.target.checked)}
          />
          {t('purchasing.suppliers.includeInactive')}
        </label>
        <button type="submit" className={buttonClass.secondary}>
          {t('inventory.items.apply')}
        </button>
      </form>

      {suppliers.isPending ? (
        <Loading />
      ) : suppliers.isError ? (
        <Failure error={suppliers.error} onRetry={() => void suppliers.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {searched === '' && !includeInactive
            ? t('purchasing.suppliers.emptyAll')
            : t('purchasing.suppliers.empty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((supplier) => (
              <li
                key={supplier.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'supplier', id: supplier.id, label: supplier.name },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.supplier(supplier.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <a
                    href={paths.supplier(supplier.id)}
                    className="truncate font-medium text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.supplier(supplier.id));
                    }}
                  >
                    {supplier.name}
                  </a>
                  <span className="truncate text-sm text-content-muted">
                    {[supplier.contactName, supplier.email, supplier.phone]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-content-muted">
                  {supplier.leadTimeDays === null
                    ? null
                    : t('purchasing.suppliers.leadTime', { count: supplier.leadTimeDays })}
                  <SupplierStatusBadge status={supplier.status} />
                </div>
              </li>
            ))}
          </ul>
          {suppliers.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={suppliers.isFetchingNextPage}
              onClick={() => void suppliers.fetchNextPage()}
            >
              {t('purchasing.suppliers.loadMore')}
            </button>
          ) : null}
        </>
      )}

      {creating ? (
        <Dialog
          title={t('purchasing.suppliers.new')}
          wide
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setCreating(false)}
              >
                {t('purchasing.suppliers.cancel')}
              </button>
              <button
                type="submit"
                form="purchasing-new-supplier"
                className={buttonClass.primary}
                disabled={!supplierDraftValid(draft) || create.isPending}
              >
                {create.isPending
                  ? t('purchasing.suppliers.creating')
                  : t('purchasing.suppliers.create')}
              </button>
            </>
          }
        >
          <form
            id="purchasing-new-supplier"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (supplierDraftValid(draft)) {
                create.mutate();
              }
            }}
          >
            <SupplierFields draft={draft} onChange={setDraft} />
            {create.isError ? <Failure error={create.error} /> : null}
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
