import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type JobPurchase, type JobPurchases, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { formatQuantity, useUnitName } from '../inventory/inventory-parts.js';
import { MediaThumbnail } from '../inventory/item-media.js';
import { buttonClass, Failure, InlineError, when } from '../ui.js';

/**
 * Parts bought from a merchant for a job (eighth round; ADR-0012), as the
 * office sees them: what, where from, how many and — to those who may see
 * costs, or whoever bought them — what one cost, with the receipt photos.
 * Nothing entered stock; they count in the job's parts cost. Whoever recorded
 * one, or anybody who moves stock, takes a mistaken one off.
 */

/** The job's merchant purchases, for seats that read stock or record parts. */
export function useJobPurchases(workOrderId: string, enabled: boolean) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.jobPurchases(workOrderId),
    queryFn: async () =>
      (
        await client.GET('/v1/work-orders/{workOrderId}/purchases', {
          params: { path: { workOrderId } },
        })
      ).data!,
    enabled,
  });
}

export function BoughtForJob({
  workOrderId,
  purchases,
  onRetry,
  failed,
}: {
  workOrderId: string;
  purchases: JobPurchases | undefined;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
  });
  const currency = settings.data?.currency ?? null;
  const movesStock = me.data?.permissions.includes('inventory.move') ?? false;

  const cancel = useMutation({
    mutationFn: async (purchaseId: string) =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/purchases/{purchaseId}/cancel', {
          params: { path: { workOrderId, purchaseId } },
        })
      ).data!,
    onSuccess: async (next) => {
      queries.setQueryData(keys.jobPurchases(workOrderId), next);
      // The job's cost counts these purchases.
      await queries.invalidateQueries({ queryKey: keys.jobCosts(workOrderId) });
    },
  });
  const open = async (receipt: JobPurchase['receipts'][number]) => {
    const url = await media.url({
      mediaId: receipt.fileId,
      contentType: receipt.contentType,
      byteSize: receipt.byteSize,
    });
    window.open(url, '_blank', 'noopener');
  };

  if (failed) {
    return <InlineError onRetry={onRetry} />;
  }
  if (purchases === undefined || purchases.items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <h3 id="job-purchases-heading" className="text-base font-semibold text-content">
        {t('inventory.bought.title')}
      </h3>
      <p className="text-xs text-content-muted">{t('inventory.bought.intro')}</p>
      <ul
        aria-labelledby="job-purchases-heading"
        className="flex flex-col divide-y divide-border-subtle text-sm"
      >
        {purchases.items.map((purchase) => {
          const cancelled = purchase.cancelledAt !== null;
          const mayCancel =
            !cancelled && (movesStock || purchase.recordedBy.id === me.data?.userId);
          return (
            <li key={purchase.id} className="flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <span
                    dir="auto"
                    className={cancelled ? 'text-content-muted line-through' : 'text-content'}
                  >
                    {purchase.description}
                    <span className="tabular-nums">
                      {' · '}
                      {formatQuantity(purchase.quantity, purchase.item?.unit, locale, unitName)}
                    </span>
                    {purchase.unitPrice === null ? null : (
                      <span className="tabular-nums">
                        {' · '}
                        {t('inventory.bought.each', {
                          price: formatAmount(purchase.unitPrice, currency, locale),
                        })}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-content-muted">
                    {purchase.merchant === null
                      ? null
                      : `${t('inventory.bought.from', { merchant: purchase.merchant })} · `}
                    {t('inventory.parts.recordedBy', {
                      name: purchase.recordedBy.name,
                      when: when(purchase.occurredAt, locale),
                    })}
                    {purchase.note === null ? null : ` · ${purchase.note}`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {cancelled ? (
                    <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
                      {t('inventory.bought.cancelled')}
                    </span>
                  ) : null}
                  {mayCancel ? (
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      disabled={cancel.isPending}
                      aria-label={t('inventory.bought.cancelNamed', {
                        description: purchase.description,
                      })}
                      onClick={() => {
                        if (window.confirm(t('inventory.bought.cancelConfirm'))) {
                          cancel.mutate(purchase.id);
                        }
                      }}
                    >
                      {t('inventory.bought.cancel')}
                    </button>
                  ) : null}
                </div>
              </div>
              {purchase.receipts.length === 0 ? null : (
                <ul aria-label={t('inventory.bought.receipts')} className="flex flex-wrap gap-2">
                  {purchase.receipts.map((receipt) => (
                    <li key={receipt.id}>
                      <button
                        type="button"
                        className="block w-16 overflow-hidden rounded border border-border-subtle"
                        aria-label={t('inventory.bought.openReceipt', { title: receipt.title })}
                        onClick={() => void open(receipt)}
                      >
                        {receipt.contentType.startsWith('image/') ? (
                          <MediaThumbnail fileId={receipt.fileId} title={receipt.title} />
                        ) : (
                          <span className="block p-2 text-xs text-accent">
                            {t('inventory.bought.receipt')}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {purchases.total === null ? null : (
        <p className="text-sm text-content">
          <span className="text-content-muted">{t('inventory.bought.total')}: </span>
          <span className="tabular-nums">{formatAmount(purchases.total, currency, locale)}</span>
        </p>
      )}
      {cancel.isError ? <Failure error={cancel.error} /> : null}
    </div>
  );
}
