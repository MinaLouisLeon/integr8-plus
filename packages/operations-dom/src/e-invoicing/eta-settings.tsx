import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type EtaAddress, type EtaSettings, keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import { useEtaAccess } from './eta-parts.js';

/**
 * The company's e-invoicing settings (ADR-0014): the issuer as registered with
 * the ETA, the environment, the credentials (write-only: never shown, never
 * echoed back), the certificates allowed to sign, and the schema documents
 * are checked against before they are sent.
 */
export function EtaSettingsPanel() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const settings = useQuery({
    queryKey: keys.etaSettings,
    queryFn: async () => (await client.GET('/v1/eta/settings')).data!,
  });
  if (settings.isPending) {
    return <Loading />;
  }
  if (settings.isError) {
    return <Failure error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  return (
    <div className="flex flex-col gap-6">
      {settings.data.server.credentialsKeyConfigured ? null : (
        <p role="alert" className="rounded-lg border border-warning bg-warning-subtle p-3 text-sm">
          {t('eta.settings.keyMissing')}
        </p>
      )}
      <IssuerForm key={settings.data.version} settings={settings.data} />
      <CredentialsCard settings={settings.data} />
      <CertificatesCard settings={settings.data} />
      <SchemasCard />
    </div>
  );
}

const ADDRESS_FIELDS: readonly (keyof EtaAddress)[] = [
  'country',
  'governate',
  'regionCity',
  'street',
  'buildingNumber',
  'postalCode',
  'floor',
  'room',
  'landmark',
  'additionalInformation',
];

const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function AddressFields({
  value,
  onChange,
}: {
  value: EtaAddress;
  onChange: (next: EtaAddress) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {ADDRESS_FIELDS.map((field) => (
        <Field
          key={field}
          label={t(`eta.address.${field}`)}
          {...(field === 'country' ? { hint: t('eta.address.countryHint') } : {})}
        >
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              dir="auto"
              className={inputClass}
              value={value[field] ?? ''}
              maxLength={field === 'country' ? 2 : 200}
              onChange={(event) => onChange({ ...value, [field]: blankToNull(event.target.value) })}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

function IssuerForm({ settings }: { settings: EtaSettings }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const access = useEtaAccess();
  const [draft, setDraft] = useState(() => ({
    enabled: settings.enabled,
    environment: settings.environment,
    taxpayerId: settings.taxpayerId ?? '',
    issuerName: settings.issuerName ?? '',
    branchId: settings.branchId ?? '',
    activityCode: settings.activityCode ?? '',
    intermediaryFor: settings.intermediaryFor ?? '',
    address: settings.address,
    defaultItemType: settings.defaultItem?.itemType ?? 'EGS',
    defaultItemCode: settings.defaultItem?.itemCode ?? '',
    confirmProduction: false,
  }));
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/eta/settings', {
          body: {
            expectedVersion: settings.version,
            enabled: draft.enabled,
            environment: draft.environment,
            confirmProduction: draft.confirmProduction,
            taxpayerId: blankToNull(draft.taxpayerId),
            issuerName: blankToNull(draft.issuerName),
            branchId: blankToNull(draft.branchId),
            activityCode: blankToNull(draft.activityCode),
            intermediaryFor: blankToNull(draft.intermediaryFor),
            address: draft.address,
            documentTypeVersion: '1.0',
            defaultItem:
              draft.defaultItemCode.trim() === ''
                ? null
                : { itemType: draft.defaultItemType, itemCode: draft.defaultItemCode.trim() },
          },
        })
      ).data!,
    onSuccess: (next) => queries.setQueryData(keys.etaSettings, next),
  });
  const text = (
    key: 'taxpayerId' | 'issuerName' | 'branchId' | 'activityCode' | 'intermediaryFor',
    hint?: string,
  ) => (
    <Field label={t(`eta.settings.${key}`)} {...(hint === undefined ? {} : { hint })}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          dir="auto"
          className={inputClass}
          value={draft[key]}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  const choosingProduction =
    draft.environment === 'production' && settings.environment !== 'production';

  return (
    <form
      className={cardClass}
      aria-labelledby="eta-issuer"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 id="eta-issuer" className="text-base font-semibold text-content">
        {t('eta.settings.title')}
      </h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        {t('eta.settings.enabled')}
      </label>
      <Field label={t('eta.settings.environment')} hint={t('eta.settings.environmentHint')}>
        {(id, describedBy) => (
          <select
            id={id}
            aria-describedby={describedBy}
            className={inputClass}
            value={draft.environment}
            onChange={(event) =>
              setDraft({ ...draft, environment: event.target.value as EtaSettings['environment'] })
            }
          >
            <option value="preprod">{t('eta.environment.preprod')}</option>
            <option
              value="production"
              disabled={
                settings.environment !== 'production' &&
                (!settings.server.productionAllowed || access.role !== 'owner')
              }
            >
              {t('eta.environment.production')}
            </option>
          </select>
        )}
      </Field>
      {settings.server.productionAllowed ? null : (
        <p className="text-xs text-content-muted">{t('eta.settings.productionLocked')}</p>
      )}
      {choosingProduction ? (
        <label className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle p-3 text-sm">
          <input
            type="checkbox"
            checked={draft.confirmProduction}
            onChange={(event) => setDraft({ ...draft, confirmProduction: event.target.checked })}
          />
          {t('eta.settings.confirmProduction')}
        </label>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {text('taxpayerId')}
        {text('issuerName')}
        {text('branchId', t('eta.settings.branchHint'))}
        {text('activityCode')}
        {text('intermediaryFor', t('eta.settings.intermediaryHint'))}
      </div>
      <h3 className="text-sm font-semibold text-content">{t('eta.settings.address')}</h3>
      <AddressFields
        value={draft.address}
        onChange={(address) => setDraft({ ...draft, address })}
      />
      <h3 className="text-sm font-semibold text-content">{t('eta.settings.defaultItem')}</h3>
      <p className="text-xs text-content-muted">{t('eta.settings.defaultItemHint')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label={t('eta.codes.itemType')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={draft.defaultItemType}
              onChange={(event) =>
                setDraft({ ...draft, defaultItemType: event.target.value as 'GS1' | 'EGS' })
              }
            >
              <option value="EGS">EGS</option>
              <option value="GS1">GS1</option>
            </select>
          )}
        </Field>
        <Field label={t('eta.codes.itemCode')}>
          {(id) => (
            <input
              id={id}
              dir="ltr"
              className={inputClass}
              value={draft.defaultItemCode}
              onChange={(event) => setDraft({ ...draft, defaultItemCode: event.target.value })}
            />
          )}
        </Field>
      </div>
      {save.error === null ? null : <Failure error={save.error} />}
      {save.isSuccess ? (
        <p role="status" className="text-sm text-content-muted">
          {t('eta.settings.saved')}
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={save.isPending || (choosingProduction && !draft.confirmProduction)}
        >
          {save.isPending ? t('eta.saving') : t('eta.save')}
        </button>
      </div>
    </form>
  );
}

function CredentialsCard({ settings }: { settings: EtaSettings }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const settled = (next: EtaSettings) => {
    queries.setQueryData(keys.etaSettings, next);
    setClientId('');
    setClientSecret('');
  };
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/eta/settings/credentials', {
          body: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        })
      ).data!,
    onSuccess: settled,
  });
  const remove = useMutation({
    mutationFn: async () => (await client.DELETE('/v1/eta/settings/credentials')).data!,
    onSuccess: settled,
  });
  const check = useMutation({
    mutationFn: async () => (await client.POST('/v1/eta/settings/credentials/check')).data!,
  });
  const { credentials } = settings;
  return (
    <section className={cardClass} aria-labelledby="eta-credentials">
      <h2 id="eta-credentials" className="text-base font-semibold text-content">
        {t('eta.credentials.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.credentials.intro')}</p>
      <p className="text-sm">
        {credentials.saved
          ? t('eta.credentials.saved', {
              hint: credentials.hint ?? '',
              date:
                credentials.updatedAt === null
                  ? '—'
                  : formatDateTime(credentials.updatedAt, { locale }),
            })
          : t('eta.credentials.none')}
      </p>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('eta.credentials.clientId')}>
          {(id) => (
            <input
              id={id}
              dir="ltr"
              autoComplete="off"
              className={inputClass}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('eta.credentials.clientSecret')}>
          {(id) => (
            <input
              id={id}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              className={inputClass}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={
              save.isPending || clientId.trim().length < 4 || clientSecret.trim().length < 4
            }
          >
            {credentials.saved ? t('eta.credentials.replace') : t('eta.credentials.save')}
          </button>
          {credentials.saved ? (
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                {t('eta.credentials.check')}
              </button>
              <button
                type="button"
                className={buttonClass.danger}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t('eta.credentials.remove')}
              </button>
            </>
          ) : null}
        </div>
      </form>
      {check.isSuccess ? (
        <p role="status" className="text-sm text-content">
          {t('eta.credentials.checked')}
        </p>
      ) : null}
      {(save.error ?? remove.error ?? check.error) ? (
        <Failure error={save.error ?? remove.error ?? check.error} />
      ) : null}
    </section>
  );
}

function CertificatesCard({ settings }: { settings: EtaSettings }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const [pem, setPem] = useState('');
  const save = useMutation({
    mutationFn: async (certificates: string[]) =>
      (await client.PUT('/v1/eta/settings/certificates', { body: { certificates } })).data!,
    onSuccess: (next) => {
      queries.setQueryData(keys.etaSettings, next.settings);
      setPem('');
    },
  });
  return (
    <section className={cardClass} aria-labelledby="eta-certificates">
      <h2 id="eta-certificates" className="text-base font-semibold text-content">
        {t('eta.certificates.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.certificates.intro')}</p>
      {settings.pinnedCertificates.length === 0 ? (
        <p className="text-sm">{t('eta.certificates.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {settings.pinnedCertificates.map((sha) => (
            <li key={sha} dir="ltr" className="break-all font-mono">
              SHA-256 {sha}
            </li>
          ))}
        </ul>
      )}
      {save.data === undefined ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {save.data.certificates.map((certificate) => (
            <li key={certificate.sha256} dir="ltr">
              {certificate.subject} — {certificate.notAfter.slice(0, 10)}
            </li>
          ))}
        </ul>
      )}
      <Field label={t('eta.certificates.add')} hint={t('eta.certificates.addHint')}>
        {(id, describedBy) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            dir="ltr"
            rows={5}
            className={`${inputClass} font-mono text-xs`}
            value={pem}
            onChange={(event) => setPem(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.primary}
          disabled={save.isPending || pem.trim().length < 100}
          onClick={() => save.mutate([pem.trim()])}
        >
          {t('eta.certificates.save')}
        </button>
        {settings.pinnedCertificates.length === 0 ? null : (
          <button
            type="button"
            className={buttonClass.danger}
            disabled={save.isPending}
            onClick={() => save.mutate([])}
          >
            {t('eta.certificates.clear')}
          </button>
        )}
      </div>
      {save.error === null ? null : <Failure error={save.error} />}
    </section>
  );
}

function SchemasCard() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const [choice, setChoice] = useState('');
  const schemas = useQuery({
    queryKey: keys.etaSchemas,
    queryFn: async () => (await client.GET('/v1/eta/schemas')).data!,
  });
  const available = useMutation({
    mutationFn: async () => (await client.GET('/v1/eta/schemas/available')).data!,
  });
  const fetchSchema = useMutation({
    mutationFn: async () => {
      const [etaTypeId, etaVersionId] = choice.split('|');
      return (
        await client.POST('/v1/eta/schemas/fetch', {
          body: {
            etaTypeId: etaTypeId ?? '',
            etaVersionId: etaVersionId ?? '',
            documentType: 'I',
            typeVersion: '1.0',
          },
        })
      ).data!;
    },
    onSuccess: () => void queries.invalidateQueries({ queryKey: keys.etaSchemas }),
  });
  return (
    <section className={cardClass} aria-labelledby="eta-schemas">
      <h2 id="eta-schemas" className="text-base font-semibold text-content">
        {t('eta.schemas.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('eta.schemas.intro')}</p>
      {schemas.data === undefined || schemas.data.items.length === 0 ? (
        <p className="text-sm">{t('eta.schemas.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {schemas.data.items.map((schema) => (
            <li key={`${schema.environment}-${schema.documentType}-${schema.typeVersion}`}>
              {t(`eta.environment.${schema.environment}`)} · {schema.documentType}{' '}
              {schema.typeVersion} · {formatDateTime(schema.fetchedAt, { locale })}
              <span dir="ltr" className="ms-2 font-mono text-xs text-content-muted">
                {schema.schemaSha256.slice(0, 16)}…
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={available.isPending}
          onClick={() => available.mutate()}
        >
          {t('eta.schemas.list')}
        </button>
        {available.data === undefined ? null : (
          <>
            <Field label={t('eta.schemas.pick')} className="min-w-64">
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">—</option>
                  {available.data.items.flatMap((type) =>
                    type.versions.map((version) => (
                      <option key={`${type.id}|${version.id}`} value={`${type.id}|${version.id}`}>
                        {type.name ?? type.id} · {version.number ?? version.id}
                        {version.status === null ? '' : ` (${version.status})`}
                      </option>
                    )),
                  )}
                </select>
              )}
            </Field>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={choice === '' || fetchSchema.isPending}
              onClick={() => fetchSchema.mutate()}
            >
              {t('eta.schemas.fetch')}
            </button>
          </>
        )}
      </div>
      {(available.error ?? fetchSchema.error) ? (
        <Failure error={available.error ?? fetchSchema.error} />
      ) : null}
    </section>
  );
}
