import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type CustomerDetail, keys, useOperations } from '../api.js';
import {
  addressText,
  BackLink,
  buttonClass,
  copyText,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  StateBadge,
  useRowMenu,
  when,
} from '../ui.js';
import {
  AddressFields,
  CustomerFields,
  customerDraft,
  emptyAddress,
  toAddressBody,
  toCustomerBody,
  type AddressDraft,
  type CustomerDraft,
} from './customer-fields.js';

/** A customer: details, contacts, sites, and recent jobs. */
export function CustomerScreen({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useOperations();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CustomerDraft | undefined>(undefined);
  const [addingSite, setAddingSite] = useState(false);
  const rowMenu = useRowMenu();

  const detail = useQuery({
    queryKey: keys.customer(customerId),
    queryFn: async () =>
      (await client.GET('/v1/customers/{customerId}', { params: { path: { customerId } } })).data!,
  });
  const save = useMutation({
    mutationFn: async (draft: CustomerDraft) =>
      (
        await client.PATCH('/v1/customers/{customerId}', {
          params: { path: { customerId } },
          body: toCustomerBody(draft),
        })
      ).data!,
    onSuccess: () => {
      setEditing(undefined);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const back = <BackLink to={paths.customers} label={t('operations.customer.back')} />;

  if (detail.isPending || detail.isError) {
    return (
      <div className="flex flex-col gap-6 text-start">
        {back}
        {detail.isPending ? (
          <Loading />
        ) : (
          <Failure error={detail.error} onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }
  const { customer, contacts, sites, recentWorkOrders, can } = detail.data;

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{customer.name}</h1>
          <p className="text-sm text-content-muted">
            {[customer.accountNumber, t(`operations.customers.status.${customer.status}`)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can.createWorkOrder ? (
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => navigate(paths.newWorkOrder({ customerId }))}
            >
              {t('operations.customer.newJob')}
            </button>
          ) : null}
          {can.edit ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setEditing(customerDraft(customer))}
            >
              {t('operations.customer.edit')}
            </button>
          ) : null}
        </div>
      </header>

      <section className={cardClass} aria-label={t('operations.workOrder.details')}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-content-muted">{t('operations.customer.email')}</dt>
            <dd dir="ltr" className="text-start text-content">
              {customer.email ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-content-muted">{t('operations.customer.phone')}</dt>
            <dd dir="ltr" className="text-start text-content">
              {customer.phone ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-content-muted">{t('operations.customer.address')}</dt>
            <dd className="text-content">{addressText(customer.address) || '—'}</dd>
          </div>
          <div>
            <dt className="text-content-muted">{t('operations.customer.tags')}</dt>
            <dd className="text-content">
              {customer.tags.length === 0 ? '—' : customer.tags.join(', ')}
            </dd>
          </div>
          {customer.notes === null ? null : (
            <div className="sm:col-span-2">
              <dt className="text-content-muted">{t('operations.customer.notes')}</dt>
              <dd className="whitespace-pre-wrap text-content">{customer.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      <Contacts detail={detail.data} onChanged={() => void detail.refetch()} />

      <section aria-labelledby="sites-heading" className={cardClass}>
        <div className="flex items-center justify-between gap-2">
          <h2 id="sites-heading" className="text-lg font-semibold text-content">
            {t('operations.customer.sites')}
          </h2>
          {can.edit ? (
            <button type="button" className={buttonClass.ghost} onClick={() => setAddingSite(true)}>
              <span aria-hidden="true">+</span>
              {t('operations.customer.addSite')}
            </button>
          ) : null}
        </div>
        {sites.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.customer.noSites')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {sites.map((site) => (
              <li
                key={site.id}
                className="flex flex-col gap-0.5 py-2"
                onContextMenu={rowMenu({ kind: 'site', id: site.id, label: site.name }, () => [
                  {
                    key: 'open',
                    label: t('operations.rowActions.open'),
                    onSelect: () => navigate(paths.site(site.id)),
                  },
                  {
                    key: 'copyId',
                    label: t('operations.rowActions.copyId'),
                    onSelect: () => copyText(site.id),
                  },
                ])}
              >
                <a
                  href={paths.site(site.id)}
                  className="font-medium text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.site(site.id));
                  }}
                >
                  {site.name}
                </a>
                <span className="text-content-muted">{addressText(site.address)}</span>
                {site.access.hazards === null ? null : (
                  <span className="text-xs text-danger">⚠ {site.access.hazards}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="jobs-heading" className={cardClass}>
        <h2 id="jobs-heading" className="text-lg font-semibold text-content">
          {t('operations.customer.recentJobs')}
        </h2>
        {recentWorkOrders.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.workOrders.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {recentWorkOrders.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a
                  href={paths.workOrder(job.id)}
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.workOrder(job.id));
                  }}
                >
                  {job.referenceLabel} · {job.title} · {job.site.name}
                </a>
                <span className="flex items-center gap-2 text-xs text-content-muted">
                  <StateBadge state={job.state} />
                  {when(job.dueBy ?? job.createdAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing === undefined ? null : (
        <Dialog
          wide
          title={t('operations.customer.edit')}
          onClose={() => setEditing(undefined)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setEditing(undefined)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={editing.name.trim() === '' || save.isPending}
                onClick={() => save.mutate(editing)}
              >
                {t('operations.customer.save')}
              </button>
            </>
          }
        >
          <CustomerFields value={editing} onChange={setEditing} />
          {save.isError ? <Failure error={save.error} /> : null}
        </Dialog>
      )}

      {addingSite ? (
        <NewSiteDialog
          customerId={customerId}
          contacts={contacts}
          onClose={() => setAddingSite(false)}
          onCreated={(siteId) => navigate(paths.site(siteId))}
        />
      ) : null}
    </div>
  );
}

function Contacts({ detail, onChanged }: { detail: CustomerDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    jobTitle: '',
    email: '',
    phone: '',
    isPrimary: false,
  });
  const add = useMutation({
    mutationFn: async () =>
      client.POST('/v1/customers/{customerId}/contacts', {
        params: {
          path: { customerId: detail.customer.id },
          header: { 'Idempotency-Key': crypto.randomUUID() },
        },
        body: {
          name: draft.name,
          jobTitle: draft.jobTitle || null,
          email: draft.email || null,
          phone: draft.phone || null,
          isPrimary: draft.isPrimary,
        },
      }),
    onSuccess: () => {
      setAdding(false);
      setDraft({ name: '', jobTitle: '', email: '', phone: '', isPrimary: false });
      onChanged();
    },
  });
  const archive = useMutation({
    mutationFn: async (contactId: string) =>
      client.PATCH('/v1/customers/{customerId}/contacts/{contactId}', {
        params: { path: { customerId: detail.customer.id, contactId } },
        body: { archived: true },
      }),
    onSuccess: onChanged,
  });

  return (
    <section aria-labelledby="contacts-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <h2 id="contacts-heading" className="text-lg font-semibold text-content">
          {t('operations.customer.contacts')}
        </h2>
        {detail.can.edit ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setAdding(true)}>
            <span aria-hidden="true">+</span>
            {t('operations.customer.addContact')}
          </button>
        ) : null}
      </div>
      {detail.contacts.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.customer.noContacts')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {detail.contacts.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex flex-col">
                <span className="font-medium text-content">
                  {contact.isPrimary
                    ? t('operations.customer.primaryContact', { name: contact.name })
                    : contact.name}
                </span>
                <span className="text-content-muted">
                  {[contact.jobTitle, contact.phone, contact.email].filter(Boolean).join(' · ')}
                </span>
              </div>
              {detail.can.edit ? (
                <button
                  type="button"
                  className={buttonClass.ghost}
                  onClick={() => archive.mutate(contact.id)}
                >
                  {t('operations.customer.archiveContact')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <Dialog
          title={t('operations.customer.addContact')}
          onClose={() => setAdding(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setAdding(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={draft.name.trim() === '' || add.isPending}
                onClick={() => add.mutate()}
              >
                {t('operations.common.add')}
              </button>
            </>
          }
        >
          {(['name', 'jobTitle', 'email', 'phone'] as const).map((key) => (
            <Field
              key={key}
              label={t(
                key === 'name' ? 'operations.customer.contactName' : `operations.customer.${key}`,
              )}
            >
              {(id) => (
                <input
                  id={id}
                  type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
                  className={inputClass}
                  value={draft[key]}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                />
              )}
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={draft.isPrimary}
              onChange={(event) => setDraft({ ...draft, isPrimary: event.target.checked })}
            />
            {t('operations.customer.primary')}
          </label>
          {add.isError ? <Failure error={add.error} /> : null}
        </Dialog>
      ) : null}
    </section>
  );
}

function NewSiteDialog({
  customerId,
  contacts,
  onClose,
  onCreated,
}: {
  customerId: string;
  contacts: CustomerDetail['contacts'];
  onClose: () => void;
  onCreated: (siteId: string) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [name, setName] = useState('');
  const [address, setAddress] = useState<AddressDraft>(emptyAddress);
  const [contactId, setContactId] = useState('');
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/customers/{customerId}/sites', {
          params: { path: { customerId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            name,
            address: { ...toAddressBody(address), line1: address.line1.trim() },
            contactId: contactId === '' ? null : contactId,
          },
        })
      ).data!,
    onSuccess: (site) => onCreated(site.id),
  });
  return (
    <Dialog
      wide
      title={t('operations.customer.addSite')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={name.trim() === '' || address.line1.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('operations.common.add')}
          </button>
        </>
      }
    >
      <Field label={t('operations.site.name')}>
        {(id) => (
          <input
            id={id}
            required
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <AddressFields value={address} onChange={setAddress} lineRequired />
      <Field label={t('operations.site.contact')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
          >
            <option value="">{t('operations.site.noContact')}</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      {create.isError ? <Failure error={create.error} /> : null}
    </Dialog>
  );
}
