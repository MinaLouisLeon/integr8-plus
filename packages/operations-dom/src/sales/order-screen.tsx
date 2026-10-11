import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type SalesOrderDetail, useOperations } from '../api.js';
import { useLocations } from '../inventory/inventory-parts.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  StateBadge,
} from '../ui.js';
import {
  DocumentLinesTable,
  type SalesLineDraft,
  salesLineBodiesOf,
  salesLineDraftsOf,
  salesLineValid,
  SalesLinesEditor,
  SalesOrderStatusBadge,
  ToOrderBadge,
} from './sales-parts.js';

/**
 * One sales order (CRM/ERP plan, phase S1; ADR-0006): its lines with what is
 * held and delivered, the jobs that deliver it, and — for those who may —
 * editing the draft, confirming it at a location, re-running the
 * reservation, cancelling, and linking or creating jobs. Nothing links on
 * its own.
 */
export function SalesOrderScreen({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [lines, setLines] = useState<SalesLineDraft[] | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [confirming, setConfirming] = useState<'confirm' | 'reserve' | null>(null);
  const [linking, setLinking] = useState(false);

  const detail = useQuery({
    queryKey: keys.salesOrder(orderId),
    queryFn: async () =>
      (await client.GET('/v1/sales/orders/{orderId}', { params: { path: { orderId } } })).data!,
  });

  const settle = async (next: SalesOrderDetail) => {
    queries.setQueryData(keys.salesOrder(orderId), next);
    await queries.invalidateQueries({ queryKey: ['sales'] });
    await queries.invalidateQueries({ queryKey: ['inventory'] });
    await queries.invalidateQueries({ queryKey: ['work-orders'] });
  };
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/sales/orders/{orderId}', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.order.version, ...body },
        })
      ).data!,
    onSuccess: async (next) => {
      setLines(null);
      setDetails(null);
      await settle(next);
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/orders/{orderId}/cancel', {
          params: { path: { orderId } },
          body: { expectedVersion: detail.data!.order.version },
        })
      ).data!,
    onSuccess: settle,
  });
  const unlink = useMutation({
    mutationFn: async (workOrderId: string) =>
      (
        await client.DELETE('/v1/sales/orders/{orderId}/work-orders/{workOrderId}', {
          params: { path: { orderId, workOrderId } },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.salesOrders} label={t('sales.orders.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { order, can, workOrders } = detail.data;
  const editing = lines !== null || details !== null;
  const error = [save.error, cancel.error, unlink.error].find((candidate) => candidate !== null);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span dir="ltr">{order.reference}</span>
            <SalesOrderStatusBadge status={order.status} />
            {order.toOrder ? <ToOrderBadge /> : null}
          </h1>
          <p className="text-lg text-content">{order.title}</p>
          <p className="text-sm text-content-muted">
            <a
              href={paths.customer(order.customer.id)}
              className="text-accent underline-offset-4 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                navigate(paths.customer(order.customer.id));
              }}
            >
              {order.customer.name}
            </a>
            {' · '}
            {t('sales.orders.createdOn', { date: formatDateTime(order.createdAt, { locale }) })}
            {order.confirmedAt === null || order.confirmedBy === null
              ? null
              : ` · ${t('sales.orders.confirmedLine', {
                  name: order.confirmedBy.name,
                  date: formatDateTime(order.confirmedAt, { locale }),
                })}`}
            {order.quote === null ? null : (
              <>
                {' · '}
                <a
                  href={paths.quote(order.quote.id)}
                  dir="ltr"
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.quote(order.quote!.id));
                  }}
                >
                  {t('sales.orders.fromQuote', { reference: order.quote.reference })}
                </a>
              </>
            )}
          </p>
          {order.reserveLocation === null ? null : (
            <p className="text-sm text-content-muted">
              {t('sales.orders.reservedAt', { location: order.reserveLocation.name })}
            </p>
          )}
          {order.status === 'cancelled' && order.cancelledAt !== null ? (
            <p className="text-sm text-content-muted">
              {t('sales.orders.cancelledLine', {
                date: formatDateTime(order.cancelledAt, { locale }),
              })}
              {order.cancelReason === null ? null : ` · ${order.cancelReason}`}
            </p>
          ) : null}
        </div>
        {editing ? null : (
          <div className="flex flex-wrap gap-2">
            {can.confirm ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setConfirming('confirm')}
              >
                {t('sales.orders.confirm')}
              </button>
            ) : null}
            {can.reserve ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setConfirming('reserve')}
              >
                {t('sales.orders.reserve')}
              </button>
            ) : null}
            {can.linkJobs ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setLinking(true)}
              >
                {t('sales.orders.linkJob')}
              </button>
            ) : null}
            {can.edit ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  save.reset();
                  setLines(salesLineDraftsOf(detail.data.lines));
                }}
              >
                {t('sales.orders.editLines')}
              </button>
            ) : null}
            {can.edit ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  save.reset();
                  setDetails(detailsOf(detail.data));
                }}
              >
                {t('sales.orders.editDetails')}
              </button>
            ) : null}
            {can.cancel ? (
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={cancel.isPending}
                onClick={() => {
                  if (window.confirm(t('sales.orders.cancelConfirm'))) {
                    cancel.mutate();
                  }
                }}
              >
                {t('sales.orders.cancelOrder')}
              </button>
            ) : null}
          </div>
        )}
      </header>

      {error === undefined ? null : <Failure error={error} />}

      {details === null ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('sales.orders.site')}</dt>
            <dd className="text-content">{order.site?.name ?? t('sales.quotes.none')}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('sales.orders.contact')}</dt>
            <dd className="text-content">{order.contact?.name ?? t('sales.quotes.none')}</dd>
          </div>
          {order.notes === null ? null : (
            <div className="flex flex-col sm:col-span-3">
              <dt className="text-content-muted">{t('sales.orders.notes')}</dt>
              <dd dir="auto" className="whitespace-pre-wrap text-content">
                {order.notes}
              </dd>
            </div>
          )}
          {order.internalNotes === null ? null : (
            <div className="flex flex-col sm:col-span-3">
              <dt className="text-content-muted">{t('sales.orders.internalNotes')}</dt>
              <dd dir="auto" className="whitespace-pre-wrap text-content">
                {order.internalNotes}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({
              title: details.title.trim(),
              notes: details.notes.trim() === '' ? null : details.notes.trim(),
              internalNotes:
                details.internalNotes.trim() === '' ? null : details.internalNotes.trim(),
            });
          }}
        >
          <Field label={t('sales.orders.fields.title')}>
            {(id) => (
              <input
                id={id}
                required
                maxLength={200}
                className={inputClass}
                value={details.title}
                onChange={(event) => setDetails({ ...details, title: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('sales.orders.notes')}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                maxLength={10_000}
                className={inputClass}
                value={details.notes}
                onChange={(event) => setDetails({ ...details, notes: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('sales.orders.internalNotes')} hint={t('sales.quotes.internalNotesHint')}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                maxLength={10_000}
                className={inputClass}
                value={details.internalNotes}
                onChange={(event) => setDetails({ ...details, internalNotes: event.target.value })}
              />
            )}
          </Field>
          <div className="flex gap-2">
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={save.isPending || details.title.trim() === ''}
            >
              {save.isPending ? t('sales.orders.saving') : t('sales.orders.save')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setDetails(null)}
            >
              {t('sales.orders.cancel')}
            </button>
          </div>
        </form>
      )}

      <section aria-labelledby="sales-order-lines" className={cardClass}>
        <h2 id="sales-order-lines" className="text-base font-semibold text-content">
          {t('sales.orders.lines')}
        </h2>
        {lines === null ? (
          detail.data.lines.length === 0 ? (
            <p className="text-sm text-content-muted">{t('sales.quotes.noLines')}</p>
          ) : (
            <DocumentLinesTable
              lines={detail.data.lines}
              totals={order.totals}
              currency={order.currencyCode}
              fulfilment={order.status !== 'draft'}
            />
          )
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (lines.every(salesLineValid)) {
                save.mutate({ lines: salesLineBodiesOf(lines) });
              }
            }}
          >
            <SalesLinesEditor lines={lines} onChange={setLines} />
            <div className="flex gap-2">
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={save.isPending || !lines.every(salesLineValid)}
              >
                {save.isPending ? t('sales.orders.saving') : t('sales.orders.save')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setLines(null)}
              >
                {t('sales.orders.cancel')}
              </button>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="sales-order-jobs" className={cardClass}>
        <h2 id="sales-order-jobs" className="text-base font-semibold text-content">
          {t('sales.orders.jobs')}
        </h2>
        {workOrders.length === 0 ? (
          <p className="text-sm text-content-muted">{t('sales.orders.noJobs')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {workOrders.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <a
                    href={paths.workOrder(job.id)}
                    dir="ltr"
                    className="font-medium text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.workOrder(job.id));
                    }}
                  >
                    {job.referenceLabel}
                  </a>
                  <span className="text-content-muted">{job.title}</span>
                  <StateBadge state={job.state} />
                </span>
                {can.linkJobs ? (
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    disabled={unlink.isPending}
                    onClick={() => {
                      if (window.confirm(t('sales.orders.unlinkConfirm'))) {
                        unlink.mutate(job.id);
                      }
                    }}
                  >
                    {t('sales.orders.unlink')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirming === null ? null : (
        <ReserveDialog
          detail={detail.data}
          mode={confirming}
          onClose={() => setConfirming(null)}
          onDone={async (next) => {
            setConfirming(null);
            await settle(next);
          }}
        />
      )}
      {linking ? (
        <LinkJobDialog
          detail={detail.data}
          onClose={() => setLinking(false)}
          onDone={async (next) => {
            setLinking(false);
            await settle(next);
          }}
        />
      ) : null}
    </div>
  );
}

interface Details {
  title: string;
  notes: string;
  internalNotes: string;
}

function detailsOf(detail: SalesOrderDetail): Details {
  return {
    title: detail.order.title,
    notes: detail.order.notes ?? '',
    internalNotes: detail.order.internalNotes ?? '',
  };
}

/** Confirming (which reserves) or re-running the reservation: both name the location. */
function ReserveDialog({
  detail,
  mode,
  onClose,
  onDone,
}: {
  detail: SalesOrderDetail;
  mode: 'confirm' | 'reserve';
  onClose: () => void;
  onDone: (next: SalesOrderDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const locations = useLocations();
  const stock = detail.lines.some((line) => line.stock);
  const [locationId, setLocationId] = useState(detail.order.reserveLocation?.id ?? '');
  const ready = !stock || locationId !== '';
  const run = useMutation({
    mutationFn: async () => {
      const params = { path: { orderId: detail.order.id } };
      const body = {
        expectedVersion: detail.order.version,
        ...(locationId === '' ? {} : { reserveLocationId: locationId }),
      };
      return mode === 'confirm'
        ? (await client.POST('/v1/sales/orders/{orderId}/confirm', { params, body })).data!
        : (await client.POST('/v1/sales/orders/{orderId}/reserve', { params, body })).data!;
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={mode === 'confirm' ? t('sales.orders.confirmTitle') : t('sales.orders.reserveTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.orders.cancel')}
          </button>
          <button
            type="submit"
            form="sales-reserve"
            className={buttonClass.primary}
            disabled={!ready || run.isPending}
          >
            {mode === 'confirm'
              ? run.isPending
                ? t('sales.orders.confirming')
                : t('sales.orders.confirm')
              : run.isPending
                ? t('sales.orders.rerunning')
                : t('sales.orders.rerun')}
          </button>
        </>
      }
    >
      <form
        id="sales-reserve"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            run.mutate();
          }
        }}
      >
        <p className="text-sm text-content">
          {mode === 'confirm' ? t('sales.orders.confirmIntro') : t('sales.orders.reserveIntro')}
        </p>
        {stock ? (
          <Field label={t('sales.orders.reserveLocation')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('sales.orders.noLocation')}</option>
                {(locations.data ?? [])
                  .filter((location) => location.archivedAt === null)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        ) : (
          <p className="text-sm text-content-muted">{t('sales.orders.noStockLines')}</p>
        )}
        {run.isError ? <Failure error={run.error} /> : null}
      </form>
    </Dialog>
  );
}

/** Link one of the customer's open jobs, or create a job for the order. */
function LinkJobDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: SalesOrderDetail;
  onClose: () => void;
  onDone: (next: SalesOrderDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const customerId = detail.order.customer.id;
  const [mode, setMode] = useState<'link' | 'create'>('link');
  const [workOrderId, setWorkOrderId] = useState('');
  const [siteId, setSiteId] = useState(detail.order.site?.id ?? '');
  const [jobTypeId, setJobTypeId] = useState('');
  const [title, setTitle] = useState(detail.order.title);
  const linked = new Set(detail.workOrders.map((job) => job.id));

  const jobs = useQuery({
    queryKey: keys.workOrders({ customerId, open: true }),
    queryFn: async () =>
      (
        await client.GET('/v1/work-orders', {
          params: {
            query: {
              customerId,
              state: [
                'scheduled',
                'dispatched',
                'travelling',
                'on_site',
                'in_progress',
                'awaiting_parts',
              ],
              order: 'created',
              limit: 50,
            },
          },
        })
      ).data!.items,
    enabled: mode === 'link',
  });
  const customer = useQuery({
    queryKey: keys.customer(customerId),
    queryFn: async () =>
      (await client.GET('/v1/customers/{customerId}', { params: { path: { customerId } } })).data!,
    enabled: mode === 'create' && detail.can.createJobs,
  });
  const jobTypes = useQuery({
    queryKey: keys.jobTypes(false),
    queryFn: async () => (await client.GET('/v1/job-types')).data!.items,
    enabled: mode === 'create' && detail.can.createJobs,
  });
  const ready =
    mode === 'link' ? workOrderId !== '' : siteId !== '' && jobTypeId !== '' && title.trim() !== '';
  const link = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/sales/orders/{orderId}/work-orders', {
          params: { path: { orderId: detail.order.id } },
          body:
            mode === 'link'
              ? { workOrderId }
              : { create: { siteId, jobTypeId, title: title.trim() } },
        })
      ).data!,
    onSuccess: onDone,
  });
  const candidates = (jobs.data ?? []).filter((job) => !linked.has(job.id));

  return (
    <Dialog
      title={t('sales.orders.linkTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('sales.orders.cancel')}
          </button>
          <button
            type="submit"
            form="sales-link-job"
            className={buttonClass.primary}
            disabled={!ready || link.isPending}
          >
            {mode === 'link'
              ? link.isPending
                ? t('sales.orders.linking')
                : t('sales.orders.link')
              : link.isPending
                ? t('sales.orders.creatingJob')
                : t('sales.orders.createJobAction')}
          </button>
        </>
      }
    >
      <form
        id="sales-link-job"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            link.mutate();
          }
        }}
      >
        <p className="text-sm text-content">{t('sales.orders.linkIntro')}</p>
        {detail.can.createJobs ? (
          <div
            role="radiogroup"
            aria-label={t('sales.orders.linkTitle')}
            className="flex gap-4 text-sm"
          >
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="sales-link-mode"
                checked={mode === 'link'}
                onChange={() => setMode('link')}
              />
              {t('sales.orders.pickJob')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="sales-link-mode"
                checked={mode === 'create'}
                onChange={() => setMode('create')}
              />
              {t('sales.orders.createJob')}
            </label>
          </div>
        ) : null}
        {mode === 'link' ? (
          jobs.isPending ? (
            <Loading />
          ) : jobs.isError ? (
            <Failure error={jobs.error} onRetry={() => void jobs.refetch()} />
          ) : candidates.length === 0 ? (
            <p className="text-sm text-content-muted">{t('sales.orders.noJobsToLink')}</p>
          ) : (
            <Field label={t('sales.orders.pickJob')}>
              {(id) => (
                <select
                  id={id}
                  required
                  className={inputClass}
                  value={workOrderId}
                  onChange={(event) => setWorkOrderId(event.target.value)}
                >
                  <option value="">{t('sales.quotes.none')}</option>
                  {candidates.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.referenceLabel} · {job.title}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )
        ) : (
          <>
            <Field label={t('sales.orders.jobSite')}>
              {(id) => (
                <select
                  id={id}
                  required
                  className={inputClass}
                  value={siteId}
                  onChange={(event) => setSiteId(event.target.value)}
                >
                  <option value="">{t('sales.quotes.none')}</option>
                  {(customer.data?.sites ?? [])
                    .filter((site) => !site.archived)
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field label={t('sales.orders.jobType')}>
              {(id) => (
                <select
                  id={id}
                  required
                  className={inputClass}
                  value={jobTypeId}
                  onChange={(event) => setJobTypeId(event.target.value)}
                >
                  <option value="">{t('sales.quotes.none')}</option>
                  {(jobTypes.data ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('sales.orders.jobTitle')} hint={t('sales.orders.jobTitleHint')}>
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={200}
                  className={inputClass}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              )}
            </Field>
          </>
        )}
        {link.isError ? <Failure error={link.error} /> : null}
      </form>
    </Dialog>
  );
}
