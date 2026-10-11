import { formatDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { addressText, BackLink, buttonClass, cardClass, Failure, Loading } from '../ui.js';
import { NewOrderDialog } from './order-list.js';
import { OrderStatusBadge, SupplierStatusBadge } from './purchasing-parts.js';
import {
  type SupplierDraft,
  supplierBodyOf,
  supplierDraftOf,
  supplierDraftValid,
  SupplierFields,
} from './supplier-list.js';

/**
 * One supplier (CRM/ERP plan, phase E2): who they are, their terms, what has
 * been ordered from them, and — for those who manage purchasing — editing
 * them, making them inactive, and drafting a new order.
 */
export function SupplierScreen({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<SupplierDraft | null>(null);
  const [ordering, setOrdering] = useState(false);

  const detail = useQuery({
    queryKey: keys.supplier(supplierId),
    queryFn: async () =>
      (
        await client.GET('/v1/purchasing/suppliers/{supplierId}', {
          params: { path: { supplierId } },
        })
      ).data!,
  });

  const patch = useMutation({
    mutationFn: async (
      body: Partial<ReturnType<typeof supplierBodyOf>> & { status?: 'active' | 'inactive' },
    ) =>
      (
        await client.PATCH('/v1/purchasing/suppliers/{supplierId}', {
          params: { path: { supplierId } },
          body: { expectedVersion: detail.data!.supplier.version, ...body },
        })
      ).data!,
    onSuccess: async () => {
      setDraft(null);
      await queries.invalidateQueries({ queryKey: ['purchasing'] });
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.suppliers} label={t('purchasing.suppliers.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { supplier, orders, can } = detail.data;
  const address = addressText(supplier.address);
  const facts: [string, string | null][] = [
    [t('purchasing.suppliers.fields.contactName'), supplier.contactName],
    [t('purchasing.suppliers.fields.email'), supplier.email],
    [t('purchasing.suppliers.fields.phone'), supplier.phone],
    [t('purchasing.suppliers.fields.taxReference'), supplier.taxReference],
    [t('purchasing.suppliers.fields.paymentTerms'), supplier.paymentTerms],
    [
      t('purchasing.suppliers.fields.leadTimeDays'),
      supplier.leadTimeDays === null ? null : String(supplier.leadTimeDays),
    ],
    [t('purchasing.suppliers.fields.line1'), address === '' ? null : address],
    [t('purchasing.suppliers.fields.notes'), supplier.notes],
  ];

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">{supplier.name}</h1>
          <SupplierStatusBadge status={supplier.status} />
        </div>
        {can.manage ? (
          <div className="flex flex-wrap gap-2">
            {supplier.status === 'active' ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setOrdering(true)}
              >
                {t('purchasing.suppliers.newOrder')}
              </button>
            ) : null}
            {draft === null ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  patch.reset();
                  setDraft(supplierDraftOf(supplier));
                }}
              >
                {t('purchasing.suppliers.edit')}
              </button>
            ) : null}
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate({ status: supplier.status === 'active' ? 'inactive' : 'active' })
              }
            >
              {supplier.status === 'active'
                ? t('purchasing.supplierStatus.inactive')
                : t('purchasing.supplierStatus.active')}
            </button>
          </div>
        ) : null}
      </header>

      {patch.isError && draft === null ? <Failure error={patch.error} /> : null}

      <section aria-labelledby="purchasing-supplier-details" className={cardClass}>
        <h2 id="purchasing-supplier-details" className="text-base font-semibold text-content">
          {t('purchasing.suppliers.details')}
        </h2>
        {draft === null ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {facts
              .filter((fact): fact is [string, string] => fact[1] !== null)
              .map(([label, value]) => (
                <div key={label} className="flex flex-col">
                  <dt className="text-content-muted">{label}</dt>
                  <dd className="break-words text-content">{value}</dd>
                </div>
              ))}
          </dl>
        ) : (
          <form
            aria-label={t('purchasing.suppliers.edit')}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (supplierDraftValid(draft)) {
                patch.mutate(supplierBodyOf(draft));
              }
            }}
          >
            <SupplierFields draft={draft} onChange={setDraft} />
            {patch.isError ? <Failure error={patch.error} /> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setDraft(null)}
              >
                {t('purchasing.suppliers.cancel')}
              </button>
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={!supplierDraftValid(draft) || patch.isPending}
              >
                {patch.isPending
                  ? t('purchasing.suppliers.saving')
                  : t('purchasing.suppliers.save')}
              </button>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="purchasing-supplier-orders" className={cardClass}>
        <h2 id="purchasing-supplier-orders" className="text-base font-semibold text-content">
          {t('purchasing.suppliers.orders')}
        </h2>
        {orders.length === 0 ? (
          <p className="text-sm text-content-muted">{t('purchasing.suppliers.noOrders')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <a
                    href={paths.purchaseOrder(order.id)}
                    dir="ltr"
                    className="font-medium text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.purchaseOrder(order.id));
                    }}
                  >
                    {order.reference}
                  </a>
                  <OrderStatusBadge status={order.status} />
                </span>
                <span className="flex items-center gap-3 text-content-muted tabular-nums">
                  {order.expectedDate === null ? null : formatDate(order.expectedDate, { locale })}
                  {order.totals === null ? null : (
                    <span className="text-content">
                      {formatAmount(order.totals.total, order.currencyCode, locale)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ordering ? (
        <NewOrderDialog
          supplier={{ id: supplier.id, name: supplier.name }}
          onClose={() => setOrdering(false)}
        />
      ) : null}
    </div>
  );
}
