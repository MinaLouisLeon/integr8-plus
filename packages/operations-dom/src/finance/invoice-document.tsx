import { formatDate, useTranslation } from '@integr8/i18n';
import type { DocumentLine } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { percentOfBasisPoints } from '../purchasing/purchasing-parts.js';
import { addressText } from '../ui.js';

/**
 * The invoice as a document (CRM/ERP plan, phase B1): what the office prints
 * or saves as a PDF from the browser and sends to the customer. The company
 * as the issued invoice names it, the customer as billed, the lines and
 * totals, and what has been credited and paid. In either language and
 * direction; the screen's print styles hide everything around it.
 */

export interface InvoiceDocumentData {
  /** `INV-000123`, or null while a draft (the document then says so). */
  reference: string | null;
  status: string;
  issuer: {
    name: string;
    address: string | null;
    taxReference: string | null;
    paymentInstructions: string | null;
    footer: string | null;
  };
  issueDate: string | null;
  dueDate: string | null;
  billedTo: {
    customerName: string;
    customerAddress: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      region?: string | null;
      postcode: string | null;
      countryCode?: string | null;
    } | null;
    contactName: string | null;
  };
  notes: string | null;
  currencyCode: string;
  lines: readonly DocumentLine[];
  totals: { gross: string; discount: string; net: string; tax: string; total: string };
  amounts: { credited: string; allocated: string; balance: string };
}

export function InvoiceDocument({
  document,
  locale,
}: {
  document: InvoiceDocumentData;
  locale: string;
}) {
  const { t } = useTranslation();
  const money = (value: string) => formatAmount(value, document.currencyCode, locale);
  const quantity = (value: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value as unknown as number);
  const anyDiscount = document.lines.some((line) => line.discountBp !== 0);
  const anyTax = document.lines.some((line) => line.taxRateBp !== 0);
  const columns = 4 + (anyDiscount ? 1 : 0) + (anyTax ? 1 : 0);
  const address =
    document.billedTo.customerAddress === null
      ? ''
      : addressText(document.billedTo.customerAddress);
  const title =
    document.reference === null
      ? t('finance.document.draftTitle')
      : t('finance.document.title', { reference: document.reference });

  return (
    <article
      aria-label={title}
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 bg-white p-8 text-start text-black print:max-w-none print:p-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-xl font-semibold">{document.issuer.name}</p>
          {document.issuer.address === null ? null : (
            <p dir="auto" className="whitespace-pre-wrap">
              {document.issuer.address}
            </p>
          )}
          {document.issuer.taxReference === null ? null : (
            <p>
              {t('finance.document.taxReference')}:{' '}
              <span dir="ltr">{document.issuer.taxReference}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end text-end">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {document.status === 'void' ? (
            <p className="mt-1 rounded border border-black px-2 py-0.5 text-xs uppercase tracking-wide">
              {t('finance.status.void')}
            </p>
          ) : null}
          {document.issueDate === null ? (
            <p className="mt-1 rounded border border-black px-2 py-0.5 text-xs uppercase tracking-wide">
              {t('finance.document.notIssued')}
            </p>
          ) : (
            <p className="text-sm">
              {t('finance.document.issuedOn', { date: formatDate(document.issueDate, { locale }) })}
            </p>
          )}
          {document.dueDate === null ? null : (
            <p className="text-sm">
              {t('finance.document.dueOn', { date: formatDate(document.dueDate, { locale }) })}
            </p>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-1 text-sm">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
          {t('finance.document.billTo')}
        </h2>
        <p className="font-medium">{document.billedTo.customerName}</p>
        {address === '' ? null : <p>{address}</p>}
        {document.billedTo.contactName === null ? null : <p>{document.billedTo.contactName}</p>}
      </section>

      <table className="w-full text-sm">
        <thead className="border-b border-black text-xs">
          <tr>
            <th scope="col" className="py-1 text-start font-medium">
              {t('sales.quotes.description')}
            </th>
            <th scope="col" className="py-1 text-end font-medium">
              {t('sales.quotes.quantity')}
            </th>
            <th scope="col" className="py-1 text-end font-medium">
              {t('sales.quotes.unitPrice')}
            </th>
            {anyDiscount ? (
              <th scope="col" className="py-1 text-end font-medium">
                {t('sales.quotes.discount')}
              </th>
            ) : null}
            {anyTax ? (
              <th scope="col" className="py-1 text-end font-medium">
                {t('sales.quotes.taxRate')}
              </th>
            ) : null}
            <th scope="col" className="py-1 text-end font-medium">
              {t('sales.quotes.total')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-300">
          {document.lines.map((line) => (
            <tr key={line.id}>
              <td className="py-2">{line.description}</td>
              <td className="py-2 text-end tabular-nums">
                {quantity(line.quantity)} {t(`inventory.unit.${line.unit}`)}
              </td>
              <td className="py-2 text-end tabular-nums">{money(line.unitPrice)}</td>
              {anyDiscount ? (
                <td className="py-2 text-end tabular-nums">
                  {line.discountBp === 0 ? '—' : `${percentOfBasisPoints(line.discountBp)}%`}
                </td>
              ) : null}
              {anyTax ? (
                <td className="py-2 text-end tabular-nums">
                  {line.taxRateBp === 0 ? '—' : `${percentOfBasisPoints(line.taxRateBp)}%`}
                </td>
              ) : null}
              <td className="py-2 text-end tabular-nums">{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-black">
          {anyDiscount ? (
            <tr>
              <th scope="row" colSpan={columns - 1} className="pt-2 text-end font-medium">
                {t('sales.quotes.discountTotal')}
              </th>
              <td className="pt-2 text-end tabular-nums">−{money(document.totals.discount)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row" colSpan={columns - 1} className="pt-2 text-end font-medium">
              {t('sales.quotes.net')}
            </th>
            <td className="pt-2 text-end tabular-nums">{money(document.totals.net)}</td>
          </tr>
          {anyTax ? (
            <tr>
              <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                {t('sales.quotes.tax')}
              </th>
              <td className="text-end tabular-nums">{money(document.totals.tax)}</td>
            </tr>
          ) : null}
          <tr className="text-base">
            <th scope="row" colSpan={columns - 1} className="pt-1 text-end font-semibold">
              {t('sales.quotes.total')}
            </th>
            <td className="pt-1 text-end font-semibold tabular-nums">
              {money(document.totals.total)}
            </td>
          </tr>
          {document.amounts.credited === '0' ? null : (
            <tr>
              <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                {t('finance.amounts.credited')}
              </th>
              <td className="text-end tabular-nums">−{money(document.amounts.credited)}</td>
            </tr>
          )}
          {document.amounts.allocated === '0' ? null : (
            <tr>
              <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                {t('finance.amounts.paid')}
              </th>
              <td className="text-end tabular-nums">−{money(document.amounts.allocated)}</td>
            </tr>
          )}
          {document.amounts.credited === '0' && document.amounts.allocated === '0' ? null : (
            <tr className="text-base">
              <th scope="row" colSpan={columns - 1} className="pt-1 text-end font-semibold">
                {t('finance.amounts.balance')}
              </th>
              <td className="pt-1 text-end font-semibold tabular-nums">
                {money(document.amounts.balance)}
              </td>
            </tr>
          )}
        </tfoot>
      </table>

      {document.notes === null ? null : (
        <p dir="auto" className="whitespace-pre-wrap text-sm">
          {document.notes}
        </p>
      )}

      {document.issuer.paymentInstructions === null ? null : (
        <section className="flex flex-col gap-1 text-sm">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
            {t('finance.document.howToPay')}
          </h2>
          <p dir="auto" className="whitespace-pre-wrap">
            {document.issuer.paymentInstructions}
          </p>
        </section>
      )}

      {document.issuer.footer === null ? null : (
        <footer dir="auto" className="mt-auto whitespace-pre-wrap text-xs text-neutral-600">
          {document.issuer.footer}
        </footer>
      )}
    </article>
  );
}
