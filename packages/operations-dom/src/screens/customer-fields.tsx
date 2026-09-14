import { useTranslation } from '@integr8/i18n';
import type { Customer } from '../api.js';
import { Field, inputClass } from '../ui.js';

export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postcode: string;
  countryCode: string;
}

export interface CustomerDraft {
  name: string;
  accountNumber: string;
  status: 'active' | 'on_hold' | 'closed';
  email: string;
  phone: string;
  address: AddressDraft;
  tags: string;
  notes: string;
}

export const emptyAddress: AddressDraft = {
  line1: '',
  line2: '',
  city: '',
  region: '',
  postcode: '',
  countryCode: '',
};

export const emptyCustomer: CustomerDraft = {
  name: '',
  accountNumber: '',
  status: 'active',
  email: '',
  phone: '',
  address: emptyAddress,
  tags: '',
  notes: '',
};

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function addressDraft(address: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  countryCode: string | null;
}): AddressDraft {
  return {
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    region: address.region ?? '',
    postcode: address.postcode ?? '',
    countryCode: address.countryCode ?? '',
  };
}

export function toAddressBody(address: AddressDraft) {
  return {
    line1: orNull(address.line1),
    line2: orNull(address.line2),
    city: orNull(address.city),
    region: orNull(address.region),
    postcode: orNull(address.postcode),
    countryCode: orNull(address.countryCode),
  };
}

export function customerDraft(customer: Customer): CustomerDraft {
  return {
    name: customer.name,
    accountNumber: customer.accountNumber ?? '',
    status: customer.status,
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    address: addressDraft(customer.address),
    tags: customer.tags.join(', '),
    notes: customer.notes ?? '',
  };
}

export function toCustomerBody(draft: CustomerDraft) {
  return {
    name: draft.name.trim(),
    accountNumber: orNull(draft.accountNumber),
    status: draft.status,
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    address: toAddressBody(draft.address),
    tags: draft.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
    notes: orNull(draft.notes),
  };
}

export function AddressFields({
  value,
  onChange,
  lineRequired = false,
}: {
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  lineRequired?: boolean;
}) {
  const { t } = useTranslation();
  const input = (key: keyof AddressDraft, className = '') => (
    <Field label={t(`operations.address.${key}`)} className={className}>
      {(id) => (
        <input
          id={id}
          className={inputClass}
          required={key === 'line1' && lineRequired}
          maxLength={key === 'countryCode' ? 2 : 200}
          value={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {input('line1', 'sm:col-span-2')}
      {input('line2', 'sm:col-span-2')}
      {input('city')}
      {input('region')}
      {input('postcode')}
      {input('countryCode')}
    </div>
  );
}

export function CustomerFields({
  value,
  onChange,
}: {
  value: CustomerDraft;
  onChange: (next: CustomerDraft) => void;
}) {
  const { t } = useTranslation();
  const text = (key: 'name' | 'accountNumber' | 'email' | 'phone', type = 'text') => (
    <Field label={t(`operations.customer.${key}`)}>
      {(id) => (
        <input
          id={id}
          type={type}
          required={key === 'name'}
          className={inputClass}
          value={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {text('name')}
        {text('accountNumber')}
        {text('email', 'email')}
        {text('phone', 'tel')}
        <Field label={t('operations.customers.status.label')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={value.status}
              onChange={(event) =>
                onChange({ ...value, status: event.target.value as CustomerDraft['status'] })
              }
            >
              {(['active', 'on_hold', 'closed'] as const).map((option) => (
                <option key={option} value={option}>
                  {t(`operations.customers.status.${option}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.customer.tags')} hint={t('operations.customer.tagsHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={value.tags}
              onChange={(event) => onChange({ ...value, tags: event.target.value })}
            />
          )}
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-content">
          {t('operations.customer.address')}
        </legend>
        <AddressFields
          value={value.address}
          onChange={(address) => onChange({ ...value, address })}
        />
      </fieldset>
      <Field label={t('operations.customer.notes')}>
        {(id) => (
          <textarea
            id={id}
            rows={3}
            className={inputClass}
            value={value.notes}
            onChange={(event) => onChange({ ...value, notes: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}
