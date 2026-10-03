import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type Priority, useOperations } from '../api.js';
import { CrewPicker, type CrewMember } from '../crew.js';
import {
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  fromLocalInput,
  inputClass,
} from '../ui.js';

/**
 * Creating a job: customer, site, type, when, and who.
 *
 * The job type fills in what it carries — its forms, checklist, instructions
 * and default priority — on the server; fields left empty here take the type's
 * values. A customer on hold asks before going ahead; a closed one is refused.
 */
export function WorkOrderFormScreen({ customerId: initialCustomerId }: { customerId?: string }) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState(initialCustomerId ?? '');
  const [siteId, setSiteId] = useState('');
  const [jobTypeId, setJobTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [onHold, setOnHold] = useState<string | undefined>(undefined);

  const customers = useQuery({
    queryKey: keys.customers({ q: search, status: ['active', 'on_hold'] }),
    queryFn: async () =>
      (
        await client.GET('/v1/customers', {
          params: {
            query: {
              ...(search === '' ? {} : { q: search }),
              status: ['active', 'on_hold'],
              limit: 50,
            },
          },
        })
      ).data!.items,
  });
  const customer = useQuery({
    queryKey: keys.customer(customerId),
    queryFn: async () =>
      (await client.GET('/v1/customers/{customerId}', { params: { path: { customerId } } })).data!,
    enabled: customerId !== '',
  });
  const jobTypes = useQuery({
    queryKey: keys.jobTypes(false),
    queryFn: async () => (await client.GET('/v1/job-types')).data!.items,
  });

  const create = useMutation({
    mutationFn: async (acknowledgeOnHold: boolean) =>
      (
        await client.POST('/v1/work-orders', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            customerId,
            siteId,
            jobTypeId,
            ...(title.trim() === '' ? {} : { title: title.trim() }),
            ...(description.trim() === '' ? {} : { description: description.trim() }),
            ...(instructions.trim() === '' ? {} : { instructions: instructions.trim() }),
            ...(priority === '' ? {} : { priority }),
            dueFrom: fromLocalInput(dueFrom),
            dueBy: fromLocalInput(dueBy),
            crew,
            ...(acknowledgeOnHold ? { acknowledgeOnHold } : {}),
          },
        })
      ).data!,
    onSuccess: (job) => navigate(paths.workOrder(job.workOrder.id)),
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'customer_on_hold') {
        setOnHold(customer.data?.customer.name ?? '');
      }
    },
  });

  const sites = (customer.data?.sites ?? []).filter((site) => !site.archived);
  const ready = customerId !== '' && siteId !== '' && jobTypeId !== '';

  return (
    <form
      className="flex flex-col gap-6 text-start"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) {
          create.mutate(false);
        }
      }}
    >
      <h1 className="text-2xl font-semibold text-content">{t('operations.workOrderForm.title')}</h1>

      <section className={cardClass}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('operations.workOrderForm.searchCustomers')}>
            {(id) => (
              <input
                id={id}
                type="search"
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrderForm.customer')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={customerId}
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setSiteId('');
                }}
              >
                <option value="">{t('operations.workOrderForm.chooseCustomer')}</option>
                {customer.data !== undefined &&
                !(customers.data ?? []).some((entry) => entry.id === customerId) ? (
                  <option value={customer.data.customer.id}>{customer.data.customer.name}</option>
                ) : null}
                {customers.data?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.accountNumber === null ? '' : ` (${entry.accountNumber})`}
                    {entry.status === 'on_hold'
                      ? ` — ${t('operations.customers.status.on_hold')}`
                      : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('operations.workOrderForm.site')}>
            {(id) => (
              <select
                id={id}
                required
                disabled={customerId === ''}
                className={inputClass}
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
              >
                <option value="">{t('operations.workOrderForm.chooseSite')}</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} — {site.address.line1}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('operations.workOrderForm.jobType')}>
            {(id) => (
              <select
                id={id}
                required
                className={inputClass}
                value={jobTypeId}
                onChange={(event) => setJobTypeId(event.target.value)}
              >
                <option value="">{t('operations.workOrderForm.chooseJobType')}</option>
                {jobTypes.data?.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </section>

      <section className={cardClass}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('operations.workOrderForm.titleLabel')}
            hint={t('operations.workOrderForm.titleHint')}
            className="sm:col-span-2"
          >
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className={inputClass}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrderForm.description')} className="sm:col-span-2">
            {(id) => (
              <textarea
                id={id}
                rows={3}
                className={inputClass}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('operations.workOrderForm.instructions')}
            hint={t('operations.workOrderForm.instructionsHint')}
            className="sm:col-span-2"
          >
            {(id, describedBy) => (
              <textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                className={inputClass}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.priority.label')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority | '')}
              >
                <option value="">{t('operations.workOrders.anyPriority')}</option>
                {(['urgent', 'high', 'normal', 'low'] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`operations.priority.${option}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div />
          <Field label={t('operations.workOrderForm.dueFrom')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className={inputClass}
                value={dueFrom}
                onChange={(event) => setDueFrom(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrderForm.dueBy')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className={inputClass}
                value={dueBy}
                onChange={(event) => setDueBy(event.target.value)}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={cardClass}>
        <CrewPicker value={crew} onChange={setCrew} />
      </section>

      {create.isError &&
      !(create.error instanceof ApiRequestError && create.error.code === 'customer_on_hold') ? (
        <Failure error={create.error} />
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={!ready || create.isPending}
          aria-busy={create.isPending}
        >
          {t('operations.workOrderForm.create')}
        </button>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => navigate(paths.workOrders)}
        >
          {t('common.cancel')}
        </button>
      </div>

      {onHold === undefined ? null : (
        <Dialog
          title={t('operations.customers.status.on_hold')}
          onClose={() => setOnHold(undefined)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setOnHold(undefined)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => {
                  setOnHold(undefined);
                  create.mutate(true);
                }}
              >
                {t('operations.workOrderForm.onHoldConfirm')}
              </button>
            </>
          }
        >
          <p className="text-content">{t('operations.workOrderForm.onHold', { name: onHold })}</p>
        </Dialog>
      )}
    </form>
  );
}
