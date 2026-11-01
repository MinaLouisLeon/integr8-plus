import { formatDate, useTranslation } from '@integr8/i18n';
import type { PurchaseOrderDetail } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { addressText } from '../ui.js';
import { percentOfBasisPoints } from './purchasing-parts.js';

/**
 * The purchase order as a document (pre-production audit, 2026-10-31): what
 * the office prints, or saves as a PDF from the browser, and sends to the
 * supplier, in the style of the printable invoice. The company as its
 * invoices name it, the supplier, delivery, the lines and totals. In either
 * language and direction; the screen's print styles hide everything around
 * it. Prices are on it only for seats that may see them.
 */
export function PurchaseOrderDocument({
  detail,
  locale,
}: {
  detail: PurchaseOrderDetail;
  locale: string;
}) {
  const { t } = useTranslation();
  const { order, lines, parties } = detail;
  const money = (value: string) => formatAmount(value, order.currencyCode, locale);
  const quantity = (value: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value as unknown as number);
  const prices = order.totals !== null;
  const anyTax = lines.some((line) => line.taxRateBp !== 0);
  const columns = 2 + (prices ? 2 : 0) + (prices && anyTax ? 1 : 0);
  const supplierAddress =
    parties.supplier.address === null ? '' : addressText(parties.supplier.address);
  const title = t('purchasing.document.title', { reference: order.reference });

  return (
    <article
      aria-label={title}
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 bg-white p-8 text-start text-black print:max-w-none print:p-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-xl font-semibold">{parties.buyer.name}</p>
          {parties.buyer.address === null ? null : (
            <p dir="auto" className="whitespace-pre-wrap">
              {parties.buyer.address}
            </p>
          )}
          {parties.buyer.taxReference === null ? null : (
            <p>
              {t('finance.document.taxReference')}:{' '}
              <span dir="ltr">{parties.buyer.taxReference}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end text-end">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {order.status === 'draft' || order.status === 'cancelled' ? (
            <p className="mt-1 rounded border border-black px-2 py-0.5 text-xs uppercase tracking-wide">
              {t(`purchasing.status.${order.status}`)}
            </p>
          ) : null}
          <p className="text-sm">
            {t('purchasing.document.orderedOn', {
              date: formatDate(order.approvedAt ?? order.createdAt, { locale }),
            })}
          </p>
          {order.expectedDate === null ? null : (
            <p className="text-sm">
              {t('purchasing.document.expectedOn', {
                date: formatDate(order.expectedDate, { locale }),
              })}
            </p>
          )}
        </div>
      </header>

      <div className="grid gap-6 text-sm sm:grid-cols-2">
        <section className="flex flex-col gap-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
            {t('purchasing.document.supplier')}
          </h2>
          <p className="font-medium">{parties.supplier.name}</p>
          {supplierAddress === '' ? null : <p>{supplierAddress}</p>}
          {parties.supplier.contactName === null ? null : <p>{parties.supplier.contactName}</p>}
          {parties.supplier.email === null ? null : <p dir="ltr">{parties.supplier.email}</p>}
          {parties.supplier.phone === null ? null : <p dir="ltr">{parties.supplier.phone}</p>}
          {parties.supplier.taxReference === null ? null : (
            <p>
              {t('finance.document.taxReference')}:{' '}
              <span dir="ltr">{parties.supplier.taxReference}</span>
            </p>
          )}
        </section>
        {order.deliveryLocation === null ? null : (
          <section className="flex flex-col gap-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
              {t('purchasing.document.deliverTo')}
            </h2>
            <p className="font-medium">{order.deliveryLocation.name}</p>
          </section>
        )}
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-black text-xs">
          <tr>
            <th scope="col" className="py-1 text-start font-medium">
              {t('sales.quotes.description')}
            </th>
            <th scope="col" className="py-1 text-end font-medium">
              {t('sales.quotes.quantity')}
            </th>
            {prices ? (
              <th scope="col" className="py-1 text-end font-medium">
                {t('sales.quotes.unitPrice')}
              </th>
            ) : null}
            {prices && anyTax ? (
              <th scope="col" className="py-1 text-end font-medium">
                {t('sales.quotes.taxRate')}
              </th>
            ) : null}
            {prices ? (
              <th scope="col" className="py-1 text-end font-medium">
                {t('sales.quotes.total')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-300">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="py-2">
                <span dir="auto">{line.description}</span>
                <span className="block text-xs text-neutral-600" dir="ltr">
                  {line.item.sku}
                </span>
              </td>
              <td className="py-2 text-end tabular-nums">
                {quantity(line.quantityOrdered)} {t(`inventory.unit.${line.item.unit}`)}
              </td>
              {prices ? (
                <td className="py-2 text-end tabular-nums">
                  {line.unitPrice === null ? '—' : money(line.unitPrice)}
                </td>
              ) : null}
              {prices && anyTax ? (
                <td className="py-2 text-end tabular-nums">
                  {line.taxRateBp === 0 ? '—' : `${percentOfBasisPoints(line.taxRateBp)}%`}
                </td>
              ) : null}
              {prices ? (
                <td className="py-2 text-end tabular-nums">
                  {line.subtotal === null ? '—' : money(line.subtotal)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        {order.totals === null ? null : (
          <tfoot className="border-t border-black">
            <tr>
              <th scope="row" colSpan={columns - 1} className="pt-2 text-end font-medium">
                {t('sales.quotes.net')}
              </th>
              <td className="pt-2 text-end tabular-nums">{money(order.totals.subtotal)}</td>
            </tr>
            {anyTax ? (
              <tr>
                <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                  {t('sales.quotes.tax')}
                </th>
                <td className="text-end tabular-nums">{money(order.totals.tax)}</td>
              </tr>
            ) : null}
            <tr className="text-base">
              <th scope="row" colSpan={columns - 1} className="pt-1 text-end font-semibold">
                {t('sales.quotes.total')}
              </th>
              <td className="pt-1 text-end font-semibold tabular-nums">
                {money(order.totals.total)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>

      {order.notes === null ? null : (
        <p dir="auto" className="whitespace-pre-wrap text-sm">
          {order.notes}
        </p>
      )}
    </article>
  );
}
