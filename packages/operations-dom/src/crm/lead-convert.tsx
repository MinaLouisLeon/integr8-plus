import { leadConvertible } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { type Customer, keys, type Lead, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';

/**
 * Converting a lead into a customer (CRM/ERP plan, phase C2): choose an
 * existing customer — suggested by email, phone or name, never merged by
 * itself — or a new one; choose who to keep as a contact; read what will
 * happen; then convert. One request, one transaction, once.
 */

type Step = 'customer' | 'contact' | 'review';

interface NewCustomer {
  name: string;
  accountNumber: string;
  email: string;
  phone: string;
}

type CustomerChoice =
  | { mode: 'existing'; customer: Pick<Customer, 'id' | 'name' | 'accountNumber'> }
  | ({ mode: 'new' } & NewCustomer);

interface NewContact {
  name: string;
  jobTitle: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

type ContactChoice =
  | { mode: 'none' }
  | { mode: 'existing'; contact: { id: string; name: string } }
  | ({ mode: 'new' } & NewContact);

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

function newCustomerFrom(lead: Lead): CustomerChoice {
  return {
    mode: 'new',
    name: lead.companyName ?? lead.displayName,
    accountNumber: '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
  };
}

function newContactFrom(lead: Lead): ContactChoice {
  return {
    mode: 'new',
    name: lead.displayName,
    jobTitle: '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    isPrimary: true,
  };
}

/** The request body, built only from what the person chose. */
function conversionBody(lead: Lead, customer: CustomerChoice, contact: ContactChoice) {
  return {
    expectedVersion: lead.version,
    customer:
      customer.mode === 'existing'
        ? { mode: 'existing' as const, customerId: customer.customer.id }
        : {
            mode: 'new' as const,
            name: customer.name.trim(),
            accountNumber: orNull(customer.accountNumber),
            email: orNull(customer.email),
            phone: orNull(customer.phone),
          },
    contact:
      contact.mode === 'none'
        ? { mode: 'none' as const }
        : contact.mode === 'existing'
          ? { mode: 'existing' as const, contactId: contact.contact.id }
          : {
              mode: 'new' as const,
              name: contact.name.trim(),
              jobTitle: orNull(contact.jobTitle),
              email: orNull(contact.email),
              phone: orNull(contact.phone),
              isPrimary: contact.isPrimary,
            },
  };
}

export function LeadConvertScreen({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const [step, setStep] = useState<Step>('customer');
  const [customer, setCustomer] = useState<CustomerChoice | null>(null);
  const [contact, setContact] = useState<ContactChoice | null>(null);
  const [search, setSearch] = useState('');
  const [searched, setSearched] = useState('');

  const detail = useQuery({
    queryKey: keys.lead(leadId),
    queryFn: async () =>
      (await client.GET('/v1/crm/leads/{leadId}', { params: { path: { leadId } } })).data!,
  });
  const convertible = detail.data?.can.convert === true;
  const matches = useQuery({
    queryKey: keys.leadMatches(leadId),
    queryFn: async () =>
      (await client.GET('/v1/crm/leads/{leadId}/matches', { params: { path: { leadId } } })).data!
        .items,
    enabled: convertible,
  });
  const found = useQuery({
    queryKey: keys.customers({ q: searched, limit: 10 }),
    queryFn: async () =>
      (await client.GET('/v1/customers', { params: { query: { q: searched, limit: 10 } } })).data!
        .items,
    enabled: convertible && searched !== '',
  });
  const chosenId = customer?.mode === 'existing' ? customer.customer.id : undefined;
  const chosen = useQuery({
    queryKey: keys.customer(chosenId ?? ''),
    queryFn: async () =>
      (
        await client.GET('/v1/customers/{customerId}', {
          params: { path: { customerId: chosenId! }, query: {} },
        })
      ).data!,
    enabled: chosenId !== undefined,
  });

  const lead = detail.data?.lead;
  const body =
    lead !== undefined && customer !== null && contact !== null
      ? conversionBody(lead, customer, contact)
      : undefined;
  // One key per distinct request: a retry of the same conversion replays the
  // first answer, and a changed choice is a new request.
  const bodyText = JSON.stringify(body ?? null);
  const idempotencyKey = useMemo(
    () => (bodyText === 'null' ? '' : crypto.randomUUID()),
    [bodyText],
  );

  const convert = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/leads/{leadId}/convert', {
          params: { path: { leadId }, header: { 'Idempotency-Key': idempotencyKey } },
          body: body!,
        })
      ).data!,
    onSuccess: async (result) => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
      await queries.invalidateQueries({ queryKey: ['customers'] });
      navigate(paths.customer(result.customerId));
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.crmLead(leadId)} label={t('crm.convert.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }
  const current = detail.data.lead;
  if (!convertible) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <h1 className="text-2xl font-semibold text-content">
          {t('crm.convert.title', { name: current.displayName })}
        </h1>
        <p role="status" className="text-sm text-content-muted">
          {current.status === 'converted'
            ? t('crm.convert.alreadyConverted')
            : !leadConvertible(current)
              ? t('crm.convert.notConvertible')
              : t('crm.convert.notAllowed')}
        </p>
      </div>
    );
  }

  const chooseCustomer = (choice: CustomerChoice) => {
    convert.reset();
    setCustomer(choice);
    // A contact chosen from another customer does not carry over.
    if (contact?.mode === 'existing') {
      setContact(null);
    }
  };

  const stepNumber = { customer: 1, contact: 2, review: 3 }[step];

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">
          {t('crm.convert.title', { name: current.displayName })}
        </h1>
        <p className="text-sm text-content-muted">
          {t('crm.convert.step', { step: stepNumber, of: 3 })}
        </p>
      </header>

      {step === 'customer' ? (
        <form
          className={cardClass}
          aria-labelledby="crm-convert-customer"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (contact === null) {
              setContact(current.companyName === null ? { mode: 'none' } : newContactFrom(current));
            }
            setStep('contact');
          }}
        >
          <h2 id="crm-convert-customer" className="text-lg font-semibold text-content">
            {t('crm.convert.customerHeading')}
          </h2>
          <p className="text-sm text-content-muted">{t('crm.convert.customerIntro')}</p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-content">
              {t('crm.convert.suggestions')}
            </legend>
            {matches.isPending ? (
              <Loading />
            ) : matches.isError ? (
              <Failure error={matches.error} onRetry={() => void matches.refetch()} />
            ) : matches.data.length === 0 ? (
              <p className="text-sm text-content-muted">{t('crm.convert.noSuggestions')}</p>
            ) : (
              matches.data.map((match) => (
                <Choice
                  key={match.customer.id}
                  name="crm-convert-customer"
                  checked={chosenId === match.customer.id}
                  onSelect={() => chooseCustomer({ mode: 'existing', customer: match.customer })}
                  label={match.customer.name}
                  hint={[
                    match.customer.accountNumber,
                    match.reasons.map((reason) => t(`crm.convert.reason.${reason}`)).join(', '),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))
            )}
          </fieldset>

          <div className="flex flex-col gap-2">
            <Field label={t('crm.convert.searchCustomers')}>
              {(id) => (
                <div className="flex gap-2">
                  <input
                    id={id}
                    type="search"
                    className={inputClass}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        setSearched(search.trim());
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => setSearched(search.trim())}
                  >
                    {t('crm.convert.search')}
                  </button>
                </div>
              )}
            </Field>
            {searched === '' ? null : found.isPending ? (
              <Loading />
            ) : found.isError ? (
              <Failure error={found.error} onRetry={() => void found.refetch()} />
            ) : found.data.length === 0 ? (
              <p className="text-sm text-content-muted">{t('crm.convert.noResults')}</p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">{t('crm.convert.results')}</legend>
                {found.data
                  .filter((item) => item.status !== 'closed')
                  .map((item) => (
                    <Choice
                      key={item.id}
                      name="crm-convert-customer"
                      checked={chosenId === item.id}
                      onSelect={() => chooseCustomer({ mode: 'existing', customer: item })}
                      label={item.name}
                      hint={item.accountNumber ?? ''}
                    />
                  ))}
              </fieldset>
            )}
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">{t('crm.convert.newCustomer')}</legend>
            <Choice
              name="crm-convert-customer"
              checked={customer?.mode === 'new'}
              onSelect={() => chooseCustomer(newCustomerFrom(current))}
              label={t('crm.convert.newCustomer')}
              hint={t('crm.convert.newCustomerHint')}
            />
            {customer?.mode === 'new' ? (
              <div className="grid gap-3 ps-6 sm:grid-cols-2">
                <Field label={t('crm.convert.fields.customerName')} className="sm:col-span-2">
                  {(id) => (
                    <input
                      id={id}
                      required
                      maxLength={200}
                      className={inputClass}
                      value={customer.name}
                      onChange={(event) =>
                        chooseCustomer({ ...customer, name: event.target.value })
                      }
                    />
                  )}
                </Field>
                <Field label={t('crm.convert.fields.accountNumber')}>
                  {(id) => (
                    <input
                      id={id}
                      maxLength={64}
                      className={inputClass}
                      value={customer.accountNumber}
                      onChange={(event) =>
                        chooseCustomer({ ...customer, accountNumber: event.target.value })
                      }
                    />
                  )}
                </Field>
                <Field label={t('crm.leads.fields.email')}>
                  {(id) => (
                    <input
                      id={id}
                      type="email"
                      dir="ltr"
                      maxLength={254}
                      className={inputClass}
                      value={customer.email}
                      onChange={(event) =>
                        chooseCustomer({ ...customer, email: event.target.value })
                      }
                    />
                  )}
                </Field>
                <Field label={t('crm.leads.fields.phone')}>
                  {(id) => (
                    <input
                      id={id}
                      type="tel"
                      dir="ltr"
                      maxLength={40}
                      className={inputClass}
                      value={customer.phone}
                      onChange={(event) =>
                        chooseCustomer({ ...customer, phone: event.target.value })
                      }
                    />
                  )}
                </Field>
              </div>
            ) : null}
          </fieldset>

          <div className="flex justify-end">
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={
                customer === null || (customer.mode === 'new' && customer.name.trim() === '')
              }
            >
              {t('crm.convert.next')}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'contact' && customer !== null ? (
        <form
          className={cardClass}
          aria-labelledby="crm-convert-contact"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setStep('review');
          }}
        >
          <h2 id="crm-convert-contact" className="text-lg font-semibold text-content">
            {t('crm.convert.contactHeading')}
          </h2>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('crm.convert.contactHeading')}</legend>
            <Choice
              name="crm-convert-contact"
              checked={contact?.mode === 'none'}
              onSelect={() => setContact({ mode: 'none' })}
              label={t('crm.convert.noContact')}
              hint=""
            />
            {customer.mode === 'existing' ? (
              chosen.isPending ? (
                <Loading />
              ) : chosen.isError ? (
                <Failure error={chosen.error} onRetry={() => void chosen.refetch()} />
              ) : (
                chosen.data.contacts
                  .filter((item) => !item.archived)
                  .map((item) => (
                    <Choice
                      key={item.id}
                      name="crm-convert-contact"
                      checked={contact?.mode === 'existing' && contact.contact.id === item.id}
                      onSelect={() => setContact({ mode: 'existing', contact: item })}
                      label={t('crm.convert.keepContact', { name: item.name })}
                      hint={[item.jobTitle, item.email, item.phone].filter(Boolean).join(' · ')}
                    />
                  ))
              )
            ) : null}
            <Choice
              name="crm-convert-contact"
              checked={contact?.mode === 'new'}
              onSelect={() => setContact(newContactFrom(current))}
              label={t('crm.convert.newContact')}
              hint=""
            />
          </fieldset>
          {contact?.mode === 'new' ? (
            <div className="grid gap-3 ps-6 sm:grid-cols-2">
              <Field label={t('crm.convert.fields.contactName')}>
                {(id) => (
                  <input
                    id={id}
                    required
                    maxLength={200}
                    className={inputClass}
                    value={contact.name}
                    onChange={(event) => setContact({ ...contact, name: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('crm.convert.fields.jobTitle')}>
                {(id) => (
                  <input
                    id={id}
                    maxLength={120}
                    className={inputClass}
                    value={contact.jobTitle}
                    onChange={(event) => setContact({ ...contact, jobTitle: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('crm.leads.fields.email')}>
                {(id) => (
                  <input
                    id={id}
                    type="email"
                    dir="ltr"
                    maxLength={254}
                    className={inputClass}
                    value={contact.email}
                    onChange={(event) => setContact({ ...contact, email: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('crm.leads.fields.phone')}>
                {(id) => (
                  <input
                    id={id}
                    type="tel"
                    dir="ltr"
                    maxLength={40}
                    className={inputClass}
                    value={contact.phone}
                    onChange={(event) => setContact({ ...contact, phone: event.target.value })}
                  />
                )}
              </Field>
              <label className="flex items-center gap-2 text-sm text-content sm:col-span-2">
                <input
                  type="checkbox"
                  checked={contact.isPrimary}
                  onChange={(event) => setContact({ ...contact, isPrimary: event.target.checked })}
                />
                {t('crm.convert.fields.primary')}
              </label>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setStep('customer')}
            >
              {t('crm.convert.previous')}
            </button>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={contact === null || (contact.mode === 'new' && contact.name.trim() === '')}
            >
              {t('crm.convert.next')}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'review' && customer !== null && contact !== null ? (
        <section className={cardClass} aria-labelledby="crm-convert-review">
          <h2 id="crm-convert-review" className="text-lg font-semibold text-content">
            {t('crm.convert.reviewHeading')}
          </h2>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-content">
            <li>
              {customer.mode === 'existing'
                ? t('crm.convert.willLink', { name: customer.customer.name })
                : t('crm.convert.willCreate', { name: customer.name.trim() })}
            </li>
            <li>
              {contact.mode === 'none'
                ? t('crm.convert.willKeepNoContact')
                : contact.mode === 'existing'
                  ? t('crm.convert.willKeepContact', { name: contact.contact.name })
                  : t('crm.convert.willAddContact', { name: contact.name.trim() })}
            </li>
            <li>{t('crm.convert.willMarkConverted', { name: current.displayName })}</li>
          </ul>
          <p className="text-sm text-content-muted">{t('crm.convert.once')}</p>
          {convert.isError ? <Failure error={convert.error} /> : null}
          <div className="flex flex-wrap justify-between gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={convert.isPending}
              onClick={() => setStep('contact')}
            >
              {t('crm.convert.previous')}
            </button>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={convert.isPending}
              onClick={() => convert.mutate()}
            >
              {convert.isPending ? t('crm.convert.converting') : t('crm.convert.confirm')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One option in a group of radio buttons, with a line saying what it is. */
function Choice({
  name,
  checked,
  onSelect,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-surface-muted">
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-1" />
      <span className="flex flex-col">
        <span className="font-medium text-content">{label}</span>
        {hint === '' ? null : <span className="text-content-muted">{hint}</span>}
      </span>
    </label>
  );
}
