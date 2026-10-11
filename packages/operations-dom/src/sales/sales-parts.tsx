import { UNITS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { type DocumentLine, type ItemRow, type QuoteStatus, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { ItemPicker } from '../inventory/inventory-parts.js';
import {
  basisPointsOfPercent,
  isPositiveQuantity,
  isQuantity,
  percentOfBasisPoints,
  QUANTITY_PATTERN,
} from '../purchasing/purchasing-parts.js';
import { buttonClass, Field, inputClass } from '../ui.js';

/**
 * Pieces the sales screens share (CRM/ERP plan, phase S1): the quote status
 * badge, the line editor quotes and orders both use (a catalogue item or a
 * line written by hand, quantity, unit, price, discount and tax typed as
 * percentages and sent as basis points), and the totals block.
 */

const STATUS_STYLE: Record<QuoteStatus, string> = {
  draft: 'border-border-subtle bg-surface-muted text-content',
  issued: 'border-accent bg-surface text-content',
  accepted: 'border-success text-content',
  rejected: 'border-danger text-danger',
  converted: 'border-border-subtle bg-surface-muted text-content-muted',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

export function QuoteStatusBadge({ status, expired }: { status: QuoteStatus; expired: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {expired ? t('sales.expired') : t(`sales.status.${status}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

type PickedItem = Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'> & { salePrice?: string | null };

export interface SalesLineDraft {
  key: string;
  item: PickedItem | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  /** Percentages as typed, such as `10` or `14.5`; empty for none. */
  discountPercent: string;
  taxPercent: string;
}

export const newSalesLine = (): SalesLineDraft => ({
  key: crypto.randomUUID(),
  item: null,
  description: '',
  quantity: '1',
  unit: 'each',
  unitPrice: '',
  discountPercent: '',
  taxPercent: '',
});

export function salesLineDraftsOf(lines: readonly DocumentLine[]): SalesLineDraft[] {
  return lines.map((line) => ({
    key: line.id,
    item:
      line.itemId === null
        ? null
        : { id: line.itemId, name: line.description, sku: '', unit: line.unit },
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    discountPercent: line.discountBp === 0 ? '' : percentOfBasisPoints(line.discountBp),
    taxPercent: line.taxRateBp === 0 ? '' : percentOfBasisPoints(line.taxRateBp),
  }));
}

const percentValid = (text: string) =>
  text.trim() === '' || basisPointsOfPercent(text) !== undefined;

export const salesLineValid = (line: SalesLineDraft) =>
  (line.item !== null || line.description.trim() !== '') &&
  isPositiveQuantity(line.quantity) &&
  isQuantity(line.unitPrice) &&
  percentValid(line.discountPercent) &&
  percentValid(line.taxPercent);

/** The request lines the drafts stand for; only call once every draft is valid. */
export function salesLineBodiesOf(lines: readonly SalesLineDraft[]) {
  return lines.map((line) => ({
    ...(line.item === null ? {} : { itemId: line.item.id }),
    ...(line.description.trim() === '' ? {} : { description: line.description.trim() }),
    quantity: line.quantity.trim(),
    unit: line.unit as DocumentLine['unit'],
    unitPrice: line.unitPrice.trim(),
    ...(line.discountPercent.trim() === ''
      ? {}
      : { discountBp: basisPointsOfPercent(line.discountPercent)! }),
    ...(line.taxPercent.trim() === '' ? {} : { taxRateBp: basisPointsOfPercent(line.taxPercent)! }),
  }));
}

export function SalesLinesEditor({
  lines,
  onChange,
}: {
  lines: SalesLineDraft[];
  onChange: (lines: SalesLineDraft[]) => void;
}) {
  const { t } = useTranslation();
  const update = (key: string, patch: Partial<SalesLineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const numeric = (
    line: SalesLineDraft,
    field: 'quantity' | 'unitPrice' | 'discountPercent' | 'taxPercent',
    label: string,
    pattern: string,
    required: boolean,
  ) => (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          required={required}
          inputMode="decimal"
          dir="ltr"
          pattern={pattern}
          className={inputClass}
          value={line[field]}
          onChange={(event) => update(line.key, { [field]: event.target.value.trim() })}
        />
      )}
    </Field>
  );
  return (
    <div className="flex flex-col gap-3">
      {lines.length === 0 ? (
        <p className="text-sm text-content-muted">{t('sales.quotes.noLines')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {lines.map((line, index) => (
            <li
              key={line.key}
              aria-label={`${t('sales.quotes.lines')} ${index + 1}`}
              className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
            >
              <ItemPicker
                label={t('sales.quotes.item')}
                hint={t('sales.quotes.itemHint')}
                kinds={['stock_item', 'non_stock_item', 'service']}
                value={line.item}
                onChange={(item) =>
                  update(line.key, {
                    item,
                    description:
                      line.description === '' || line.description === line.item?.name
                        ? (item?.name ?? '')
                        : line.description,
                    unit: item?.unit ?? line.unit,
                    unitPrice:
                      item !== null && 'salePrice' in item && typeof item.salePrice === 'string'
                        ? item.salePrice
                        : line.unitPrice,
                  })
                }
              />
              <div className="grid gap-3 sm:grid-cols-6">
                <Field label={t('sales.quotes.description')} className="sm:col-span-6">
                  {(id) => (
                    <input
                      id={id}
                      required={line.item === null}
                      maxLength={500}
                      className={inputClass}
                      value={line.description}
                      onChange={(event) => update(line.key, { description: event.target.value })}
                    />
                  )}
                </Field>
                {numeric(line, 'quantity', t('sales.quotes.quantity'), QUANTITY_PATTERN, true)}
                <Field label={t('sales.quotes.unit')}>
                  {(id) => (
                    <select
                      id={id}
                      className={inputClass}
                      value={line.unit}
                      onChange={(event) => update(line.key, { unit: event.target.value })}
                    >
                      {UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {t(`inventory.unit.${unit}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {numeric(line, 'unitPrice', t('sales.quotes.unitPrice'), QUANTITY_PATTERN, true)}
                {numeric(
                  line,
                  'discountPercent',
                  t('sales.quotes.discount'),
                  String.raw`\d{1,3}(\.\d{1,2})?`,
                  false,
                )}
                {numeric(
                  line,
                  'taxPercent',
                  t('sales.quotes.taxRate'),
                  String.raw`\d{1,3}(\.\d{1,2})?`,
                  false,
                )}
                <div className="flex items-end">
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() =>
                      onChange(lines.filter((candidate) => candidate.key !== line.key))
                    }
                  >
                    {t('sales.quotes.removeLine')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className={`${buttonClass.secondary} self-start`}
        onClick={() => onChange([...lines, newSalesLine()])}
      >
        {t('sales.quotes.addLine')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading lines and totals
// ---------------------------------------------------------------------------

export function DocumentLinesTable({
  lines,
  totals,
  currency,
}: {
  lines: readonly DocumentLine[];
  totals: { gross: string; discount: string; net: string; tax: string; total: string };
  currency: string;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const money = (value: string) => formatAmount(value, currency, locale);
  const quantity = (value: string) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value as unknown as number);
  const anyDiscount = lines.some((line) => line.discountBp !== 0);
  const anyTax = lines.some((line) => line.taxRateBp !== 0);
  const columns = 4 + (anyDiscount ? 1 : 0) + (anyTax ? 1 : 0);
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-content-muted">
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
      <tbody className="divide-y divide-border-subtle">
        {lines.map((line) => (
          <tr key={line.id}>
            <td className="py-2 text-content">{line.description}</td>
            <td className="py-2 text-end text-content tabular-nums">
              {quantity(line.quantity)} {t(`inventory.unit.${line.unit}`)}
            </td>
            <td className="py-2 text-end text-content tabular-nums">{money(line.unitPrice)}</td>
            {anyDiscount ? (
              <td className="py-2 text-end text-content tabular-nums">
                {line.discountBp === 0 ? '—' : `${percentOfBasisPoints(line.discountBp)}%`}
              </td>
            ) : null}
            {anyTax ? (
              <td className="py-2 text-end text-content tabular-nums">
                {line.taxRateBp === 0 ? '—' : `${percentOfBasisPoints(line.taxRateBp)}%`}
              </td>
            ) : null}
            <td className="py-2 text-end text-content tabular-nums">{money(line.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="text-content">
        {anyDiscount ? (
          <>
            <tr>
              <th scope="row" colSpan={columns - 1} className="pt-3 text-end font-medium">
                {t('sales.quotes.gross')}
              </th>
              <td className="pt-3 text-end tabular-nums">{money(totals.gross)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={columns - 1} className="text-end font-medium">
                {t('sales.quotes.discountTotal')}
              </th>
              <td className="text-end tabular-nums">−{money(totals.discount)}</td>
            </tr>
          </>
        ) : null}
        <tr>
          <th scope="row" colSpan={columns - 1} className="pt-3 text-end font-medium">
            {t('sales.quotes.net')}
          </th>
          <td className="pt-3 text-end tabular-nums">{money(totals.net)}</td>
        </tr>
        {anyTax ? (
          <tr>
            <th scope="row" colSpan={columns - 1} className="text-end font-medium">
              {t('sales.quotes.tax')}
            </th>
            <td className="text-end tabular-nums">{money(totals.tax)}</td>
          </tr>
        ) : null}
        <tr>
          <th scope="row" colSpan={columns - 1} className="text-end font-semibold">
            {t('sales.quotes.total')}
          </th>
          <td className="text-end font-semibold tabular-nums">{money(totals.total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
