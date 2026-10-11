import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import type { DocumentLine } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { addressText } from '../ui.js';
import { percentOfBasisPoints } from '../purchasing/purchasing-parts.js';

/**
 * The quote as a document (CRM/ERP plan, phase S1): what the customer reads
 * on their link and what the office prints or saves as a PDF from the
 * browser. One layout for both, in either language and direction, with no
 * app chrome: the page's own print styles hide everything around it.
 */

export interface QuoteDocumentData {
  company: { name: string; logoUrl: string | null };
  reference: string;
  title: string;
  /** Null while a draft: the document shows a draft watermark. */
  issuedAt: string | null;
  validUntil: string | null;
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
  introduction: string | null;
  terms: string | null;
  currencyCode: string;
  lines: readonly DocumentLine[];
  totals: { gross: string; discount: string; net: string; tax: string; total: string };
  answer: { status: 'accepted' | 'rejected'; at: string; name: string | null } | null;
}

export function QuoteDocument({
  document,
  locale,
  className = '',
}: {
  document: QuoteDocumentData;
  locale: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const money = (value: string) => formatAmount(value, document.currencyCode, locale);
  const quantity = (value: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value as unknown as number);
  const anyDiscount = document.lines.some((line) => line.discountBp !== 0);
  const anyTax = document.lines.some((line) => line.taxRateBp !== 0);
  const columns = 4 + (anyDiscount ? 1 : 0) + (anyTax ? 1 : 0);
  const address = document.customerAddress === null ? '' : addressText(document.customerAddress);

  return (
    <article
      className={`mx-auto flex w-full max-w-3xl flex-col gap-8 bg-white p-8 text-start text-black print:max-w-none print:p-0 ${className}`}
      aria-label={t('sales.public.title', { reference: document.reference })}
    >
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          {document.company.logoUrl === null ? null : (
            <img src={document.company.logoUrl} alt="" className="h-14 w-auto object-contain" />
          )}
          <p className="text-xl font-semibold">{document.company.name}</p>
        </div>
        <div className="flex flex-col items-end text-end">
          <h1 className="text-2xl font-semibold">
            {t('sales.public.title', { reference: document.reference })}
          </h1>
          <p className="text-sm">{document.title}</p>
          {document.issuedAt === null ? (
            <p className="mt-1 rounded border border-black px-2 py-0.5 text-xs uppercase tracking-wide">
              {t('sales.quotes.draftWatermark')}
            </p>
          ) : (
            <p className="text-sm">
              {t('sales.public.issuedOn', { date: formatDate(document.issuedAt, { locale }) })}
            </p>
          )}
          {document.validUntil === null ? null : (
            <p className="text-sm">
              {t('sales.public.validUntil', { date: formatDate(document.validUntil, { locale }) })}
            </p>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-1 text-sm">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
          {t('sales.public.for')}
        </h2>
        <p className="font-medium">{document.customerName}</p>
        {address === '' ? null : <p>{address}</p>}
        {document.contactName === null ? null : <p>{document.contactName}</p>}
      </section>

      {document.introduction === null ? null : (
        <p dir="auto" className="whitespace-pre-wrap text-sm">
          {document.introduction}
        </p>
      )}

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
            <>
              <tr>
                <th scope="row" colSpan={columns - 1} className="pt-2 text-end font-medium">
                  {t('sales.quotes.gross')}
                </th>
                <td className="pt-2 text-end tabular-nums">{money(document.totals.gross)}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                  {t('sales.quotes.discountTotal')}
                </th>
                <td className="text-end tabular-nums">−{money(document.totals.discount)}</td>
              </tr>
            </>
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
        </tfoot>
      </table>

      {document.terms === null ? null : (
        <section className="flex flex-col gap-1 text-sm">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-600">
            {t('sales.public.terms')}
          </h2>
          <p dir="auto" className="whitespace-pre-wrap">
            {document.terms}
          </p>
        </section>
      )}

      {document.answer === null ? null : (
        <p className="text-sm font-medium">
          {document.answer.status === 'accepted'
            ? t('sales.public.accepted', { date: formatDateTime(document.answer.at, { locale }) })
            : t('sales.public.rejected', { date: formatDateTime(document.answer.at, { locale }) })}
          {document.answer.name === null
            ? null
            : ` ${t('sales.public.acceptedBy', { name: document.answer.name })}`}
        </p>
      )}

      <footer className="mt-auto text-xs text-neutral-600">{t('sales.public.poweredBy')}</footer>
    </article>
  );
}
