import { multiplyDecimal } from '@integr8/core';
import { formatCalendarDate, formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type Bom, type ItemRow, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import {
  formatQuantity,
  ItemPicker,
  KindBadge,
  useUnitName,
} from '../inventory/inventory-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import { NewAssemblyOrderDialog } from './assembly-order-list.js';
import {
  AppLink,
  AssemblyStatusBadge,
  Detail,
  DirectionBadge,
  isAmount,
  isPositiveQuantity,
  ManufacturingFailure,
  ManufacturingGate,
  QUANTITY_PATTERN,
  useCurrency,
  useManufacturingSeat,
} from './manufacturing-parts.js';

/**
 * One item's bill of materials (seventh round; ADR-0011): the version in use
 * with what one unit is built from and what it costs, the versions before it,
 * the orders drafted for the item, and — for those who keep bills — saving a
 * new version or retiring it.
 */
export function BomScreen({ itemId }: { itemId: string }) {
  return (
    <ManufacturingGate>
      <BomDetail itemId={itemId} />
    </ManufacturingGate>
  );
}

type PickedItem = Pick<ItemRow, 'id' | 'name' | 'sku' | 'unit'>;

interface ComponentDraft {
  key: string;
  item: PickedItem | null;
  quantity: string;
}

interface BomDraft {
  components: ComponentDraft[];
  labourCost: string;
  overheadCost: string;
  note: string;
}

const newComponent = (): ComponentDraft => ({
  key: crypto.randomUUID(),
  item: null,
  quantity: '',
});

function draftOf(bom: Bom | null): BomDraft {
  if (bom === null) {
    return { components: [newComponent()], labourCost: '', overheadCost: '', note: '' };
  }
  return {
    components: bom.components.map((component) => ({
      key: component.item.id,
      item: component.item,
      quantity: component.quantity,
    })),
    labourCost: bom.labourCost === null || bom.labourCost === '0' ? '' : bom.labourCost,
    overheadCost: bom.overheadCost === null || bom.overheadCost === '0' ? '' : bom.overheadCost,
    note: bom.note ?? '',
  };
}

function BomDetail({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const seat = useManufacturingSeat();
  const [draft, setDraft] = useState<BomDraft | null>(null);
  const [ordering, setOrdering] = useState(false);

  const bill = useQuery({
    queryKey: keys.bom(itemId),
    queryFn: async () =>
      (
        await client.GET('/v1/manufacturing/boms/items/{itemId}', {
          params: { path: { itemId } },
        })
      ).data!,
  });
  const item = useQuery({
    queryKey: keys.item(itemId),
    queryFn: async () =>
      (await client.GET('/v1/inventory/items/{itemId}', { params: { path: { itemId } } })).data!,
  });
  const orders = useQuery({
    queryKey: keys.assemblyOrders({ itemId, limit: 10 }),
    queryFn: async () =>
      (
        await client.GET('/v1/manufacturing/orders', {
          params: { query: { itemId, limit: 10 } },
        })
      ).data!.items,
  });

  const settle = async () => {
    await queries.invalidateQueries({ queryKey: ['manufacturing'] });
  };
  const save = useMutation({
    mutationFn: async (next: BomDraft) =>
      (
        await client.PUT('/v1/manufacturing/boms/items/{itemId}', {
          params: { path: { itemId } },
          body: {
            components: next.components.map((component) => ({
              itemId: component.item!.id,
              quantity: component.quantity.trim(),
            })),
            labourCost: next.labourCost.trim() === '' ? '0' : next.labourCost.trim(),
            overheadCost: next.overheadCost.trim() === '' ? '0' : next.overheadCost.trim(),
            note: next.note.trim() === '' ? null : next.note.trim(),
          },
        })
      ).data!,
    onSuccess: async () => {
      setDraft(null);
      await settle();
    },
  });
  const retire = useMutation({
    mutationFn: async () =>
      client.DELETE('/v1/manufacturing/boms/items/{itemId}', { params: { path: { itemId } } }),
    onSuccess: settle,
  });

  if (bill.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.boms} label={t('manufacturing.boms.back')} />;
  if (bill.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <ManufacturingFailure error={bill.error} onRetry={() => void bill.refetch()} />
      </div>
    );
  }

  const { current, versions } = bill.data;
  const subject = current?.item ?? item.data?.item;
  // Saving a bill sends labour and overhead; a seat that cannot see them
  // would send zero over them, so only those who see costs keep bills.
  const canKeep = seat.manage && seat.seesCosts;
  const buildable = subject?.kind === 'stock_item';
  const editing = draft !== null;
  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-content-muted">{t('manufacturing.bom.heading')}</p>
          <h1 className="text-2xl font-semibold break-words text-content">
            {subject?.name ?? t('manufacturing.bom.item')}
          </h1>
          {subject === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
              <span dir="ltr">{subject.sku}</span>
              <KindBadge kind={subject.kind} />
              {current === null ? null : (
                <span className="inline-flex items-center rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-content">
                  {t('manufacturing.boms.versionN', {
                    version: formatNumber(current.version, { locale }),
                  })}
                </span>
              )}
              <AppLink to={paths.item(itemId)}>{t('manufacturing.bom.openItem')}</AppLink>
            </div>
          )}
        </div>
        {editing ? null : (
          <div className="flex flex-wrap gap-2">
            {current !== null && seat.manage ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setOrdering(true)}
              >
                {t('manufacturing.bom.newOrder')}
              </button>
            ) : null}
            {canKeep && current !== null ? (
              <>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    save.reset();
                    setDraft(draftOf(current));
                  }}
                >
                  {t('manufacturing.bom.edit')}
                </button>
                <button
                  type="button"
                  className={buttonClass.danger}
                  disabled={retire.isPending}
                  onClick={() => {
                    if (window.confirm(t('manufacturing.bom.retireConfirm'))) {
                      retire.mutate();
                    }
                  }}
                >
                  {retire.isPending
                    ? t('manufacturing.bom.retiring')
                    : t('manufacturing.bom.retire')}
                </button>
              </>
            ) : null}
          </div>
        )}
      </header>

      {retire.isError ? <ManufacturingFailure error={retire.error} /> : null}

      {editing ? (
        <BomEditor
          itemId={itemId}
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => save.mutate(draft)}
          saving={save.isPending}
          error={save.error}
          isNew={current === null}
        />
      ) : current === null ? (
        <section className={cardClass} aria-labelledby="bom-none">
          <h2 id="bom-none" className="text-base font-semibold text-content">
            {t('manufacturing.bom.none')}
          </h2>
          {canKeep && buildable ? (
            <>
              <p className="text-sm text-content-muted">{t('manufacturing.bom.noneHint')}</p>
              <button
                type="button"
                className={`${buttonClass.primary} self-start`}
                onClick={() => {
                  save.reset();
                  setDraft(draftOf(null));
                }}
              >
                {t('manufacturing.bom.create')}
              </button>
            </>
          ) : subject !== undefined && !buildable ? (
            <p className="text-sm text-content-muted">{t('manufacturing.bom.notStock')}</p>
          ) : null}
        </section>
      ) : (
        <BomComponents bom={current} />
      )}

      <section className={cardClass} aria-labelledby="bom-versions">
        <h2 id="bom-versions" className="text-base font-semibold text-content">
          {t('manufacturing.bom.versions')}
        </h2>
        <p className="text-sm text-content-muted">{t('manufacturing.bom.versionsHint')}</p>
        {versions.length === 0 ? (
          <p className="text-sm text-content-muted">{t('manufacturing.bom.noVersions')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <AppLink to={paths.bomVersion(version.id)}>
                  {t('manufacturing.boms.versionN', {
                    version: formatNumber(version.version, { locale }),
                  })}
                </AppLink>
                <span className="flex items-center gap-3 text-content-muted">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${
                      version.superseded
                        ? 'border-border-subtle text-content-muted'
                        : 'border-accent text-content'
                    }`}
                  >
                    {version.superseded
                      ? t('manufacturing.bom.superseded')
                      : t('manufacturing.bom.current')}
                  </span>
                  <span>{formatDateTime(version.createdAt, { locale })}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cardClass} aria-labelledby="bom-orders">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="bom-orders" className="text-base font-semibold text-content">
            {t('manufacturing.bom.orders')}
          </h2>
          <AppLink to={paths.assemblyOrders}>{t('manufacturing.bom.allOrders')}</AppLink>
        </div>
        {orders.isPending ? (
          <Loading />
        ) : orders.isError ? (
          <ManufacturingFailure error={orders.error} onRetry={() => void orders.refetch()} />
        ) : orders.data.length === 0 ? (
          <p className="text-sm text-content-muted">{t('manufacturing.bom.noOrders')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {orders.data.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <AppLink to={paths.assemblyOrder(order.id)} dir="ltr">
                    {order.reference}
                  </AppLink>
                  <AssemblyStatusBadge status={order.status} />
                  <DirectionBadge direction={order.direction} />
                </span>
                <span className="flex items-center gap-3 text-content-muted tabular-nums">
                  <span className="text-content">
                    {formatQuantity(order.quantity, order.item.unit, locale, unitName)}
                  </span>
                  <span>{order.location.name}</span>
                  {order.plannedFor === null ? null : (
                    <span>{formatCalendarDate(order.plannedFor, { locale })}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ordering && current !== null ? (
        <NewAssemblyOrderDialog
          item={{ id: current.item.id, sku: current.item.sku, name: current.item.name }}
          onClose={() => setOrdering(false)}
        />
      ) : null}
    </div>
  );
}

/** Problems with a draft the API would refuse, found before it is sent. */
type DraftProblem =
  { kind: 'noComponents' } | { kind: 'self' } | { kind: 'duplicate'; name: string };

function draftProblems(itemId: string, draft: BomDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.components.length === 0) {
    problems.push({ kind: 'noComponents' });
  }
  const seen = new Set<string>();
  for (const component of draft.components) {
    if (component.item === null) {
      continue;
    }
    if (component.item.id === itemId) {
      problems.push({ kind: 'self' });
    } else if (seen.has(component.item.id)) {
      problems.push({ kind: 'duplicate', name: component.item.name });
    }
    seen.add(component.item.id);
  }
  return problems;
}

function BomEditor({
  itemId,
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
  isNew,
}: {
  itemId: string;
  draft: BomDraft;
  onChange: (draft: BomDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: unknown;
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const unitName = useUnitName();
  const update = (key: string, patch: Partial<ComponentDraft>) =>
    onChange({
      ...draft,
      components: draft.components.map((component) =>
        component.key === key ? { ...component, ...patch } : component,
      ),
    });
  const problems = draftProblems(itemId, draft).map((problem) =>
    problem.kind === 'duplicate'
      ? t('manufacturing.bom.editor.duplicate', { name: problem.name })
      : t(`manufacturing.bom.editor.${problem.kind}`),
  );
  const ready =
    problems.length === 0 &&
    draft.components.every(
      (component) => component.item !== null && isPositiveQuantity(component.quantity),
    ) &&
    (draft.labourCost.trim() === '' || isAmount(draft.labourCost)) &&
    (draft.overheadCost.trim() === '' || isAmount(draft.overheadCost));
  const title = isNew ? t('manufacturing.bom.create') : t('manufacturing.bom.edit');

  return (
    <form
      aria-label={title}
      className={cardClass}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          onSave();
        }
      }}
    >
      <h2 className="text-base font-semibold text-content">{title}</h2>
      <p className="text-sm text-content-muted">{t('manufacturing.bom.editor.intro')}</p>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-content">
          {t('manufacturing.bom.components')}
        </legend>
        <ol className="flex flex-col gap-3">
          {draft.components.map((component, index) => (
            <li
              key={component.key}
              aria-label={t('manufacturing.bom.editor.componentN', { number: index + 1 })}
              className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3"
            >
              <ItemPicker
                label={t('manufacturing.bom.component')}
                kinds={['stock_item', 'non_stock_item']}
                value={component.item}
                onChange={(picked) => update(component.key, { item: picked })}
              />
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label={t('manufacturing.bom.editor.quantity')}
                  {...(component.item === null ? {} : { hint: unitName(component.item.unit) })}
                  className="w-48"
                >
                  {(id, describedBy) => (
                    <input
                      id={id}
                      required
                      inputMode="decimal"
                      dir="ltr"
                      pattern={QUANTITY_PATTERN}
                      aria-describedby={describedBy}
                      className={inputClass}
                      value={component.quantity}
                      onChange={(event) =>
                        update(component.key, { quantity: event.target.value.trim() })
                      }
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className={buttonClass.ghost}
                  onClick={() =>
                    onChange({
                      ...draft,
                      components: draft.components.filter(
                        (candidate) => candidate.key !== component.key,
                      ),
                    })
                  }
                >
                  {t('manufacturing.bom.editor.remove')}
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`${buttonClass.secondary} self-start`}
          onClick={() => onChange({ ...draft, components: [...draft.components, newComponent()] })}
        >
          {t('manufacturing.bom.editor.add')}
        </button>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('manufacturing.bom.labourCost')}
          hint={t('manufacturing.bom.editor.costHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY_PATTERN}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.labourCost}
              onChange={(event) => onChange({ ...draft, labourCost: event.target.value.trim() })}
            />
          )}
        </Field>
        <Field
          label={t('manufacturing.bom.overheadCost')}
          hint={t('manufacturing.bom.editor.costHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              inputMode="decimal"
              dir="ltr"
              pattern={QUANTITY_PATTERN}
              aria-describedby={describedBy}
              className={inputClass}
              value={draft.overheadCost}
              onChange={(event) => onChange({ ...draft, overheadCost: event.target.value.trim() })}
            />
          )}
        </Field>
        <Field label={t('manufacturing.bom.note')} className="sm:col-span-2">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              maxLength={1000}
              className={inputClass}
              value={draft.note}
              onChange={(event) => onChange({ ...draft, note: event.target.value })}
            />
          )}
        </Field>
      </div>
      {problems.length === 0 ? null : (
        <ul role="alert" className="list-disc ps-5 text-sm text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {error === null ? null : <ManufacturingFailure error={error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass.secondary} onClick={onCancel}>
          {t('manufacturing.bom.editor.cancel')}
        </button>
        <button type="submit" className={buttonClass.primary} disabled={!ready || saving}>
          {saving ? t('manufacturing.bom.editor.saving') : t('manufacturing.bom.editor.save')}
        </button>
      </div>
    </form>
  );
}

/**
 * What one unit of a bill's item is built from, with each line's cost and the
 * rolled-up cost for those who see costs, and the bill's note. The version in
 * use and an earlier one read the same way.
 */
export function BomComponents({ bom }: { bom: Bom }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const unitName = useUnitName();
  const currency = useCurrency();
  const money = (value: string) => formatAmount(value, currency, locale);
  return (
    <section className={cardClass} aria-labelledby="bom-components">
      <h2 id="bom-components" className="text-base font-semibold text-content">
        {t('manufacturing.bom.components')}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-content-muted">
            <tr>
              <th scope="col" className="py-1 text-start font-medium">
                {t('manufacturing.bom.component')}
              </th>
              <th scope="col" className="py-1 text-end font-medium">
                {t('manufacturing.bom.perUnit')}
              </th>
              {bom.unitCost === null ? null : (
                <>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('manufacturing.bom.unitCost')}
                  </th>
                  <th scope="col" className="py-1 text-end font-medium">
                    {t('manufacturing.bom.lineCost')}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {bom.components.map((component) => (
              <tr key={component.item.id}>
                <td className="py-2">
                  <AppLink to={paths.item(component.item.id)}>{component.item.name}</AppLink>
                  <span dir="ltr" className="ms-2 text-content-muted">
                    {component.item.sku}
                  </span>
                </td>
                <td className="py-2 text-end tabular-nums">
                  {formatQuantity(component.quantity, component.item.unit, locale, unitName)}
                </td>
                {component.unitCost === null ? null : (
                  <>
                    <td className="py-2 text-end tabular-nums">{money(component.unitCost)}</td>
                    <td className="py-2 text-end tabular-nums">
                      {money(multiplyDecimal(component.quantity, component.unitCost))}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {bom.unitCost === null ? null : (
            <tfoot className="border-t border-border-subtle">
              <tr>
                <th
                  scope="row"
                  colSpan={3}
                  className="py-1 text-end font-normal text-content-muted"
                >
                  {t('manufacturing.bom.labourCost')}
                </th>
                <td className="py-1 text-end tabular-nums">{money(bom.labourCost ?? '0')}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  colSpan={3}
                  className="py-1 text-end font-normal text-content-muted"
                >
                  {t('manufacturing.bom.overheadCost')}
                </th>
                <td className="py-1 text-end tabular-nums">{money(bom.overheadCost ?? '0')}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={3} className="py-1 text-end font-semibold text-content">
                  {t('manufacturing.bom.rolledUp')}
                </th>
                <td className="py-1 text-end font-semibold tabular-nums">{money(bom.unitCost)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {bom.unitCost === null ? null : (
        <p className="text-xs text-content-muted">{t('manufacturing.bom.rolledUpHint')}</p>
      )}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Detail label={t('manufacturing.bom.note')} wide>
          {bom.note === null ? null : <span className="whitespace-pre-wrap">{bom.note}</span>}
        </Detail>
      </dl>
      <p className="text-xs text-content-muted">
        {t('manufacturing.bom.savedBy', {
          name: bom.createdBy.name,
          date: formatDateTime(bom.createdAt, { locale }),
        })}
      </p>
    </section>
  );
}
