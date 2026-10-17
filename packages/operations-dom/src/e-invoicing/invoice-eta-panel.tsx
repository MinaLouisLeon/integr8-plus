import { ETA_RECEIVER_TYPES } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type EtaAddress, keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, inputClass } from '../ui.js';
import { EtaStateBadge, idempotencyKey, useEtaAccess, useReadinessText } from './eta-parts.js';
import { AddressFields } from './eta-settings.js';

const EMPTY_ADDRESS: EtaAddress = {
  country: 'EG',
  governate: null,
  regionCity: null,
  street: null,
  buildingNumber: null,
  postalCode: null,
  floor: null,
  room: null,
  landmark: null,
  additionalInformation: null,
};

/**
 * An invoice's e-invoicing panel (PLAN §3): whether it is ready to become an
 * ETA document and what stops it, the customer's ETA details, preparing the
 * document, and every document made from it. Shown on issued invoices of a
 * company with the module on, to those who may read it.
 */
export function InvoiceEtaPanel({
  invoiceId,
  customerId,
  currencyCode,
}: {
  invoiceId: string;
  customerId: string;
  currencyCode: string;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useEtaAccess();
  const readinessText = useReadinessText();
  const [exchangeRate, setExchangeRate] = useState('');
  const [editingReceiver, setEditingReceiver] = useState(false);
  const rate = /^\d{1,9}(\.\d{1,5})?$/u.test(exchangeRate.trim()) ? exchangeRate.trim() : '';

  const panel = useQuery({
    queryKey: keys.etaInvoice(invoiceId, rate),
    enabled: access.read,
    queryFn: async () =>
      (
        await client.GET('/v1/eta/invoices/{invoiceId}', {
          params: {
            path: { invoiceId },
            query: rate === '' ? {} : { exchangeRate: rate },
          },
        })
      ).data!,
  });
  const prepare = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/eta/invoices/{invoiceId}/prepare', {
          params: { path: { invoiceId }, header: { 'Idempotency-Key': idempotencyKey() } },
          body: rate === '' ? {} : { exchangeRate: rate },
        })
      ).data!,
    onSuccess: (document) => {
      void queries.invalidateQueries({ queryKey: ['eta'] });
      navigate(paths.etaDocument(document.id));
    },
  });

  if (!access.read) {
    return null;
  }
  const errors = panel.data?.readiness.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = panel.data?.readiness.filter((issue) => issue.severity === 'warning') ?? [];
  const receiverProblem = errors.some((issue) => issue.code.startsWith('receiver_'));

  return (
    <section className={cardClass} aria-labelledby="invoice-eta">
      <h2 id="invoice-eta" className="text-base font-semibold text-content">
        {t('eta.invoice.title')}
      </h2>
      {panel.isError ? <Failure error={panel.error} onRetry={() => void panel.refetch()} /> : null}
      {panel.data === undefined ? null : (
        <>
          {panel.data.enabled ? (
            <p className="text-sm text-content-muted">
              {t('eta.invoice.environment', {
                environment: t(`eta.environment.${panel.data.environment}`),
              })}
            </p>
          ) : (
            <p className="text-sm text-content-muted">{t('eta.invoice.disabled')}</p>
          )}
          {currencyCode === 'EGP' ? null : (
            <Field
              label={t('eta.invoice.exchangeRate', { currency: currencyCode })}
              hint={t('eta.invoice.exchangeRateHint')}
              className="max-w-xs"
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  dir="ltr"
                  inputMode="decimal"
                  className={inputClass}
                  value={exchangeRate}
                  onChange={(event) => setExchangeRate(event.target.value)}
                />
              )}
            </Field>
          )}
          {errors.length === 0 ? (
            <p role="status" className="text-sm text-content">
              {t('eta.invoice.ready')}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-content">{t('eta.invoice.fixFirst')}</p>
              <ul className="list-disc ps-5 text-sm text-content">
                {errors.map((issue) => (
                  <li key={`${issue.code}-${issue.path}`}>{readinessText(issue)}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-content">{t('eta.invoice.worthALook')}</p>
              <ul className="list-disc ps-5 text-sm text-content-muted">
                {warnings.map((issue) => (
                  <li key={`${issue.code}-${issue.path}`}>{readinessText(issue)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {access.prepare && panel.data.enabled ? (
              <button
                type="button"
                className={buttonClass.primary}
                disabled={errors.length > 0 || prepare.isPending}
                onClick={() => prepare.mutate()}
              >
                {panel.data.documents.length === 0
                  ? t('eta.actions.prepare')
                  : t('eta.actions.prepareAgain')}
              </button>
            ) : null}
            {access.configure ? (
              <button
                type="button"
                className={receiverProblem ? buttonClass.primary : buttonClass.secondary}
                onClick={() => setEditingReceiver(true)}
              >
                {t('eta.receiver.edit')}
              </button>
            ) : null}
          </div>
          {prepare.error === null ? null : <Failure error={prepare.error} />}
          {panel.data.documents.length === 0 ? (
            <p className="text-sm text-content-muted">{t('eta.invoice.none')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {panel.data.documents.map((document) => (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <a
                      href={paths.etaDocument(document.id)}
                      className="text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.etaDocument(document.id));
                      }}
                    >
                      {t('eta.document.sequence', { sequence: document.sequence })}
                    </a>
                    <EtaStateBadge state={document.state} />
                  </span>
                  <span className="text-content-muted">
                    {formatDateTime(document.preparedAt, { locale })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {editingReceiver ? (
        <ReceiverDialog
          customerId={customerId}
          onClose={() => setEditingReceiver(false)}
          onSaved={() => {
            setEditingReceiver(false);
            void queries.invalidateQueries({ queryKey: ['eta'] });
          }}
        />
      ) : null}
    </section>
  );
}

function ReceiverDialog({
  customerId,
  onClose,
  onSaved,
}: {
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useOperations();
  const codes = useQuery({
    queryKey: keys.etaCodes,
    queryFn: async () => (await client.GET('/v1/eta/codes')).data!,
  });
  const current = codes.data?.receivers.find((receiver) => receiver.customerId === customerId);
  if (codes.isPending) {
    return null;
  }
  return (
    <ReceiverForm
      key={current?.updatedAt ?? 'new'}
      customerId={customerId}
      initial={{
        receiverType: current?.receiverType ?? 'B',
        receiverId: current?.receiverId ?? '',
        address: current?.address ?? EMPTY_ADDRESS,
      }}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function ReceiverForm({
  customerId,
  initial,
  onClose,
  onSaved,
}: {
  customerId: string;
  initial: { receiverType: 'B' | 'P' | 'F'; receiverId: string; address: EtaAddress };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [draft, setDraft] = useState(initial);
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/eta/receivers/{customerId}', {
          params: { path: { customerId } },
          body: {
            receiverType: draft.receiverType,
            receiverId: draft.receiverId.trim() === '' ? null : draft.receiverId.trim(),
            address: draft.address,
          },
        })
      ).data!,
    onSuccess: onSaved,
  });
  return (
    <Dialog
      wide
      title={t('eta.receiver.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('eta.save')}
          </button>
        </>
      }
    >
      <p className="text-content-muted">{t('eta.receiver.intro')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('eta.receiver.type')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.receiverType}
              onChange={(event) =>
                setDraft({ ...draft, receiverType: event.target.value as 'B' | 'P' | 'F' })
              }
            >
              {ETA_RECEIVER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`eta.receiver.types.${type}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('eta.receiver.id')} hint={t(`eta.receiver.idHint.${draft.receiverType}`)}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              dir="ltr"
              className={inputClass}
              value={draft.receiverId}
              onChange={(event) => setDraft({ ...draft, receiverId: event.target.value })}
            />
          )}
        </Field>
      </div>
      <AddressFields
        value={draft.address}
        onChange={(address) => setDraft({ ...draft, address })}
      />
      {save.error === null ? null : <Failure error={save.error} />}
    </Dialog>
  );
}
