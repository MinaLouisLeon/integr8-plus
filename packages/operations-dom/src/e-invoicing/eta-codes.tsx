import { ETA_MAPPABLE_UNITS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type EtaCodes, keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * The codes an ETA document carries (ADR-0014): each unit's ETA unit type,
 * each tax rate's ETA type and subtype, and catalogue items' own GS1 or EGS
 * codes. All are typed by the company from the ETA's code tables; nothing
 * here suggests a value.
 */
export function EtaCodesPanel() {
  const { client } = useOperations();
  const codes = useQuery({
    queryKey: keys.etaCodes,
    queryFn: async () => (await client.GET('/v1/eta/codes')).data!,
  });
  if (codes.isPending) {
    return <Loading />;
  }
  if (codes.isError) {
    return <Failure error={codes.error} onRetry={() => void codes.refetch()} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <UnitsCard key={`units-${JSON.stringify(codes.data.unitTypes)}`} codes={codes.data} />
      <TaxesCard key={`taxes-${JSON.stringify(codes.data.taxMappings)}`} codes={codes.data} />
      <ItemCodesCard codes={codes.data} />
    </div>
  );
}

function UnitsCard({ codes }: { codes: EtaCodes }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...codes.unitTypes }));
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/eta/unit-types', {
          body: {
            unitTypes: Object.fromEntries(
              Object.entries(draft)
                .map(([unit, code]) => [unit, code.trim()] as const)
                .filter(([, code]) => code !== ''),
            ),
          },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: keys.etaCodes }),
  });
  return (
    <section className={cardClass} aria-labelledby="eta-units">
      <h2 id="eta-units" className="text-base font-semibold text-content">
        {t('eta.codes.units')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.codes.unitsHint')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ETA_MAPPABLE_UNITS.map((unit) => (
          <Field key={unit} label={t(`inventory.unit.${unit}`)}>
            {(id) => (
              <input
                id={id}
                dir="ltr"
                className={inputClass}
                value={draft[unit] ?? ''}
                maxLength={20}
                onChange={(event) => setDraft({ ...draft, [unit]: event.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      {save.error === null ? null : <Failure error={save.error} />}
      <div>
        <button
          type="button"
          className={buttonClass.primary}
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('eta.save')}
        </button>
      </div>
    </section>
  );
}

interface TaxRow {
  rate: string;
  taxType: string;
  subType: string;
}

function TaxesCard({ codes }: { codes: EtaCodes }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const [rows, setRows] = useState<TaxRow[]>(() =>
    codes.taxMappings.map((mapping) => ({
      rate: String(mapping.taxRateBp / 100),
      taxType: mapping.taxType,
      subType: mapping.subType,
    })),
  );
  const valid = rows.every(
    (row) =>
      /^\d{1,3}(\.\d{1,2})?$/u.test(row.rate.trim()) &&
      row.taxType.trim() !== '' &&
      row.subType.trim() !== '',
  );
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/eta/tax-mappings', {
          body: {
            taxMappings: rows.map((row) => ({
              taxRateBp: Math.round(Number(row.rate.trim()) * 100),
              taxType: row.taxType.trim(),
              subType: row.subType.trim(),
            })),
          },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: keys.etaCodes }),
  });
  const set = (index: number, patch: Partial<TaxRow>) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <section className={cardClass} aria-labelledby="eta-taxes">
      <h2 id="eta-taxes" className="text-base font-semibold text-content">
        {t('eta.codes.taxes')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.codes.taxesHint')}</p>
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[8rem_1fr_1fr_auto]"
        >
          <Field label={t('eta.codes.rate')}>
            {(id) => (
              <input
                id={id}
                dir="ltr"
                inputMode="decimal"
                className={inputClass}
                value={row.rate}
                onChange={(event) => set(index, { rate: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('eta.codes.taxType')}>
            {(id) => (
              <input
                id={id}
                dir="ltr"
                className={inputClass}
                value={row.taxType}
                onChange={(event) => set(index, { taxType: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('eta.codes.subType')}>
            {(id) => (
              <input
                id={id}
                dir="ltr"
                className={inputClass}
                value={row.subType}
                onChange={(event) => set(index, { subType: event.target.value })}
              />
            )}
          </Field>
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => setRows(rows.filter((_, at) => at !== index))}
          >
            {t('eta.codes.remove')}
          </button>
        </div>
      ))}
      {save.error === null ? null : <Failure error={save.error} />}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => setRows([...rows, { rate: '14', taxType: '', subType: '' }])}
        >
          {t('eta.codes.addTax')}
        </button>
        <button
          type="button"
          className={buttonClass.primary}
          disabled={save.isPending || !valid}
          onClick={() => save.mutate()}
        >
          {t('eta.save')}
        </button>
      </div>
    </section>
  );
}

function ItemCodesCard({ codes }: { codes: EtaCodes }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const [search, setSearch] = useState('');
  const items = useQuery({
    queryKey: keys.items({ q: search, purpose: 'eta' }),
    queryFn: async () =>
      (
        await client.GET('/v1/inventory/items', {
          params: { query: { limit: 25, ...(search.trim() === '' ? {} : { q: search.trim() }) } },
        })
      ).data!,
    retry: false,
  });
  const byItem = new Map(codes.itemCodes.map((code) => [code.itemId, code]));
  const save = useMutation({
    mutationFn: async (input: { itemId: string; itemType: 'GS1' | 'EGS'; itemCode: string }) =>
      input.itemCode.trim() === ''
        ? (
            await client.DELETE('/v1/eta/item-codes/{itemId}', {
              params: { path: { itemId: input.itemId } },
            })
          ).data!
        : (
            await client.PUT('/v1/eta/item-codes/{itemId}', {
              params: { path: { itemId: input.itemId } },
              body: { itemType: input.itemType, itemCode: input.itemCode.trim() },
            })
          ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: keys.etaCodes }),
  });
  return (
    <section className={cardClass} aria-labelledby="eta-items">
      <h2 id="eta-items" className="text-base font-semibold text-content">
        {t('eta.codes.itemCodes')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.codes.itemCodesHint')}</p>
      <Field label={t('eta.codes.search')}>
        {(id) => (
          <input
            id={id}
            type="search"
            dir="auto"
            className={inputClass}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </Field>
      {items.isError ? (
        <p className="text-sm text-content-muted">{t('eta.codes.itemsUnavailable')}</p>
      ) : null}
      {items.data === undefined ? null : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {items.data.items.map((item) => (
            <ItemCodeRow
              key={`${item.id}-${byItem.get(item.id)?.itemCode ?? ''}`}
              name={item.name}
              sku={item.sku}
              current={byItem.get(item.id) ?? null}
              saving={save.isPending}
              onSave={(itemType, itemCode) => save.mutate({ itemId: item.id, itemType, itemCode })}
            />
          ))}
        </ul>
      )}
      {save.error === null ? null : <Failure error={save.error} />}
    </section>
  );
}

function ItemCodeRow({
  name,
  sku,
  current,
  saving,
  onSave,
}: {
  name: string;
  sku: string;
  current: { itemType: 'GS1' | 'EGS'; itemCode: string } | null;
  saving: boolean;
  onSave: (itemType: 'GS1' | 'EGS', itemCode: string) => void;
}) {
  const { t } = useTranslation();
  const [itemType, setItemType] = useState<'GS1' | 'EGS'>(current?.itemType ?? 'EGS');
  const [itemCode, setItemCode] = useState(current?.itemCode ?? '');
  return (
    <li className="grid grid-cols-1 items-end gap-2 py-2 sm:grid-cols-[1fr_7rem_1fr_auto]">
      <span>
        <span dir="auto">{name}</span>
        <span dir="ltr" className="ms-2 text-xs text-content-muted">
          {sku}
        </span>
      </span>
      <select
        aria-label={t('eta.codes.itemType')}
        className={inputClass}
        value={itemType}
        onChange={(event) => setItemType(event.target.value as 'GS1' | 'EGS')}
      >
        <option value="EGS">EGS</option>
        <option value="GS1">GS1</option>
      </select>
      <input
        aria-label={t('eta.codes.itemCode')}
        dir="ltr"
        className={inputClass}
        value={itemCode}
        onChange={(event) => setItemCode(event.target.value)}
      />
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={saving}
        onClick={() => onSave(itemType, itemCode)}
      >
        {t('eta.save')}
      </button>
    </li>
  );
}
