import { isZeroDecimal } from '@integr8/core';
import { formatCalendarDate, formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { keys, type PlanDrafted, type PlanSuggestion, useOperations } from '../api.js';
import { formatQuantity, useLocations, useUnitName } from '../inventory/inventory-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import { AppLink, ManufacturingFailure, ManufacturingGate } from './manufacturing-parts.js';

/**
 * One planning run (seventh round; ADR-0011): what to build and buy, level by
 * level — what is sold first, then its parts — with when each must be
 * ordered, what it rests on, and — for those who may — drafting assembly and
 * purchase orders from the chosen suggestions.
 */
export function MaterialPlanScreen({ planId }: { planId: string }) {
  return (
    <ManufacturingGate>
      <MaterialPlanDetail planId={planId} />
    </ManufacturingGate>
  );
}

/** Why a suggestion cannot be chosen; undefined when it can. */
type Blocked = 'drafted' | 'noSupplier' | 'noPurchasing' | 'readOnly';

function MaterialPlanDetail({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const unitName = useUnitName();
  const locations = useLocations();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [locationId, setLocationId] = useState('');
  const [drafted, setDrafted] = useState<PlanDrafted | null>(null);

  const plan = useQuery({
    queryKey: keys.materialPlan(planId),
    queryFn: async () =>
      (await client.GET('/v1/manufacturing/plans/{planId}', { params: { path: { planId } } }))
        .data!,
  });

  const request = { suggestionIds: [...selected].sort(), locationId };
  const requestText = JSON.stringify(request);
  const idempotencyKey = useMemo(
    () => (requestText === '' ? '' : crypto.randomUUID()),
    [requestText],
  );
  const draft = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/manufacturing/plans/{planId}/draft', {
          params: { path: { planId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: request,
        })
      ).data!,
    onSuccess: async (result) => {
      queries.setQueryData(keys.materialPlan(planId), result.plan);
      setDrafted(result);
      setSelected(new Set());
      await queries.invalidateQueries({ queryKey: ['manufacturing', 'orders'] });
      await queries.invalidateQueries({ queryKey: ['purchasing'] });
    },
  });

  const levels = useMemo(() => {
    const byLevel = new Map<number, PlanSuggestion[]>();
    for (const suggestion of plan.data?.suggestions ?? []) {
      byLevel.set(suggestion.level, [...(byLevel.get(suggestion.level) ?? []), suggestion]);
    }
    return [...byLevel.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, rows]) => ({
        level,
        rows: [...rows].sort(
          (a, b) => a.orderBy.localeCompare(b.orderBy) || a.item.name.localeCompare(b.item.name),
        ),
      }));
  }, [plan.data]);

  if (plan.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.materialPlans} label={t('manufacturing.plans.back')} />;
  if (plan.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <ManufacturingFailure error={plan.error} onRetry={() => void plan.refetch()} />
      </div>
    );
  }

  const { can, suggestions } = plan.data;
  const blocked = (suggestion: PlanSuggestion): Blocked | undefined => {
    if (suggestion.drafted !== null) return 'drafted';
    if (!can.draftAssemblies) return 'readOnly';
    if (suggestion.action === 'buy' && !can.draftPurchases) return 'noPurchasing';
    if (suggestion.action === 'buy' && suggestion.supplier === null) return 'noSupplier';
    return undefined;
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    draft.reset();
  };
  const hasBuys = suggestions.some((s) => s.action === 'buy' && s.drafted === null);
  const missingSupplier = suggestions.some(
    (s) => s.action === 'buy' && s.supplier === null && s.drafted === null,
  );
  const quantity = (value: string, suggestion: PlanSuggestion) =>
    formatQuantity(value, suggestion.item.unit, locale, unitName);
  const reload = () => {
    draft.reset();
    setSelected(new Set());
    void plan.refetch();
  };

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">
          {t('manufacturing.plans.heading', {
            date: formatCalendarDate(plan.data.horizonEnd, { locale }),
          })}
        </h1>
        <p className="text-sm text-content-muted">
          {t('manufacturing.plans.runBy', {
            name: plan.data.runBy.name,
            date: formatDateTime(plan.data.runAt, { locale }),
          })}
        </p>
      </header>

      {!can.draftAssemblies ? (
        <p
          role="note"
          className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-content"
        >
          {t('manufacturing.plans.readOnly')}
        </p>
      ) : (
        <>
          {hasBuys && !can.draftPurchases ? (
            <p
              role="note"
              className="rounded-lg border border-warning bg-warning-subtle p-3 text-sm text-content"
            >
              {t('manufacturing.plans.buysDisabled')}
            </p>
          ) : null}
          {missingSupplier && can.draftPurchases ? (
            <p
              role="note"
              className="rounded-lg border border-warning bg-warning-subtle p-3 text-sm text-content"
            >
              {t('manufacturing.plans.missingSupplier')}
            </p>
          ) : null}
        </>
      )}

      {drafted === null ? null : (
        <section
          aria-live="polite"
          aria-labelledby="plan-drafted"
          className="flex flex-col gap-2 rounded-lg border border-success bg-success-subtle p-4 text-sm text-content"
        >
          <h2 id="plan-drafted" className="font-semibold">
            {t('manufacturing.plans.draftedTitle')}
          </h2>
          {drafted.assemblyOrders.length === 0 ? null : (
            <p className="flex flex-wrap items-center gap-2">
              <span>{t('manufacturing.plans.draftedAssemblies')}</span>
              {drafted.assemblyOrders.map((order) => (
                <AppLink key={order.id} to={paths.assemblyOrder(order.id)} dir="ltr">
                  {order.reference}
                </AppLink>
              ))}
            </p>
          )}
          {drafted.purchaseOrders.length === 0 ? null : (
            <p className="flex flex-wrap items-center gap-2">
              <span>{t('manufacturing.plans.draftedPurchases')}</span>
              {drafted.purchaseOrders.map((order) => (
                <AppLink key={order.id} to={paths.purchaseOrder(order.id)} dir="ltr">
                  {order.reference}
                </AppLink>
              ))}
            </p>
          )}
        </section>
      )}

      {suggestions.length === 0 ? (
        <p className={`${cardClass} text-sm text-content-muted`}>
          {t('manufacturing.plans.noSuggestions')}
        </p>
      ) : (
        <form
          aria-label={t('manufacturing.plans.suggestions')}
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected.size > 0 && locationId !== '') {
              draft.mutate();
            }
          }}
        >
          <p className="text-sm text-content-muted">{t('manufacturing.plans.levelsHint')}</p>
          {levels.map(({ level, rows }) => (
            <section key={level} aria-labelledby={`plan-level-${level}`} className={cardClass}>
              <h2 id={`plan-level-${level}`} className="text-base font-semibold text-content">
                {t('manufacturing.plans.level', { level: formatNumber(level, { locale }) })}
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-content-muted">
                    <tr>
                      {can.draftAssemblies ? (
                        <th scope="col" className="w-8 py-1 text-start font-medium">
                          <span className="sr-only">{t('manufacturing.plans.choose')}</span>
                        </th>
                      ) : null}
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.item')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.action')}
                      </th>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('manufacturing.plans.quantity')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.needBy')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.orderBy')}
                      </th>
                      <th scope="col" className="py-1 text-end font-medium">
                        {t('manufacturing.plans.leadTime')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.supplier')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.basis')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('manufacturing.plans.order')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle align-top">
                    {rows.map((suggestion) => {
                      const reason = blocked(suggestion);
                      const late = suggestion.basis.lateByDays > 0;
                      const basis = [
                        ['sales', suggestion.basis.sales],
                        ['assembly', suggestion.basis.assembly],
                        ['parent', suggestion.basis.parent],
                      ] as const;
                      return (
                        <tr key={suggestion.id}>
                          {can.draftAssemblies ? (
                            <td className="py-2">
                              <input
                                type="checkbox"
                                aria-label={t('manufacturing.plans.select', {
                                  item: suggestion.item.name,
                                })}
                                disabled={reason !== undefined}
                                checked={selected.has(suggestion.id)}
                                onChange={(event) => toggle(suggestion.id, event.target.checked)}
                              />
                            </td>
                          ) : null}
                          <td className="py-2">
                            <AppLink to={paths.item(suggestion.item.id)}>
                              {suggestion.item.name}
                            </AppLink>
                            <span dir="ltr" className="block text-xs text-content-muted">
                              {suggestion.item.sku}
                            </span>
                          </td>
                          <td className="py-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                                suggestion.action === 'build'
                                  ? 'border-accent text-content'
                                  : 'border-border-subtle text-content'
                              }`}
                            >
                              {t(`manufacturing.plans.actions.${suggestion.action}`)}
                            </span>
                          </td>
                          <td className="py-2 text-end font-medium tabular-nums">
                            {quantity(suggestion.quantity, suggestion)}
                          </td>
                          <td className="py-2 whitespace-nowrap">
                            {formatCalendarDate(suggestion.needBy, { locale })}
                          </td>
                          <td className="py-2">
                            <span className="whitespace-nowrap">
                              {formatCalendarDate(suggestion.orderBy, { locale })}
                            </span>
                            {late ? (
                              <span className="mt-1 block w-fit rounded-full border border-danger bg-danger-subtle px-2 py-0.5 text-xs font-semibold text-danger">
                                {t('manufacturing.plans.late', {
                                  count: suggestion.basis.lateByDays,
                                })}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2 text-end whitespace-nowrap tabular-nums">
                            {t('manufacturing.plans.days', { count: suggestion.leadTimeDays })}
                          </td>
                          <td className="py-2">
                            {suggestion.supplier !== null ? (
                              <AppLink to={paths.supplier(suggestion.supplier.id)}>
                                {suggestion.supplier.name}
                              </AppLink>
                            ) : suggestion.action === 'buy' ? (
                              <span className="text-danger">
                                {t('manufacturing.plans.noSupplier')}
                              </span>
                            ) : (
                              <span className="text-content-muted">—</span>
                            )}
                          </td>
                          <td className="py-2 text-xs text-content-muted">
                            <ul className="flex flex-col gap-0.5">
                              {basis
                                .filter(([, value]) => !isZeroDecimal(value))
                                .map(([key, value]) => (
                                  <li key={key}>
                                    {t(`manufacturing.plans.from.${key}`, {
                                      quantity: quantity(value, suggestion),
                                    })}
                                  </li>
                                ))}
                              <li>
                                {t('manufacturing.plans.required', {
                                  quantity: quantity(suggestion.required, suggestion),
                                })}
                              </li>
                              <li>
                                {t('manufacturing.plans.available', {
                                  quantity: quantity(suggestion.available, suggestion),
                                })}
                              </li>
                              {isZeroDecimal(suggestion.onOrder) ? null : (
                                <li>
                                  {t('manufacturing.plans.onOrder', {
                                    quantity: quantity(suggestion.onOrder, suggestion),
                                  })}
                                </li>
                              )}
                              {isZeroDecimal(suggestion.reorderMinimum) ? null : (
                                <li>
                                  {t('manufacturing.plans.reorderLevel', {
                                    quantity: quantity(suggestion.reorderMinimum, suggestion),
                                  })}
                                </li>
                              )}
                            </ul>
                          </td>
                          <td className="py-2">
                            {suggestion.drafted !== null ? (
                              <AppLink
                                to={
                                  suggestion.drafted.kind === 'assembly_order'
                                    ? paths.assemblyOrder(suggestion.drafted.id)
                                    : paths.purchaseOrder(suggestion.drafted.id)
                                }
                              >
                                {t(`manufacturing.plans.drafted.${suggestion.drafted.kind}`)}
                              </AppLink>
                            ) : reason === 'noSupplier' || reason === 'noPurchasing' ? (
                              <span className="text-xs text-content-muted">
                                {t(`manufacturing.plans.blocked.${reason}`)}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {can.draftAssemblies ? (
            <div className={`${cardClass} sm:flex-row sm:items-end sm:justify-between`}>
              <Field label={t('manufacturing.plans.location')} className="sm:w-72">
                {(id) => (
                  <select
                    id={id}
                    className={inputClass}
                    value={locationId}
                    onChange={(event) => {
                      draft.reset();
                      setLocationId(event.target.value);
                    }}
                  >
                    <option value="">{t('manufacturing.orders.chooseLocation')}</option>
                    {(locations.data ?? []).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-content-muted" aria-live="polite">
                  {t('manufacturing.plans.selected', { count: selected.size })}
                </span>
                <button
                  type="submit"
                  className={buttonClass.primary}
                  disabled={selected.size === 0 || locationId === '' || draft.isPending}
                >
                  {draft.isPending
                    ? t('manufacturing.plans.drafting')
                    : t('manufacturing.plans.draft')}
                </button>
              </div>
            </div>
          ) : null}
          {draft.isError ? (
            <ManufacturingFailure
              error={draft.error}
              onReload={reload}
              forbidden={t('manufacturing.errors.noPurchasing')}
            />
          ) : null}
        </form>
      )}
    </div>
  );
}
