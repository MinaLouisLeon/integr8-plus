import { ETA_DOCUMENT_STATES } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type EtaDocumentState, keys, useOperations } from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import { EtaCodesPanel } from './eta-codes.js';
import { EtaStateBadge, useEtaAccess } from './eta-parts.js';
import { EtaSettingsPanel } from './eta-settings.js';

/**
 * E-invoicing (docs/e-invoicing; ADR-0014): the register of ETA documents,
 * and — for owners and admins — the company's settings, credentials,
 * certificates, schema and codes. Documents are prepared from an invoice's
 * own page; this screen follows them afterwards.
 */
export function EtaScreen() {
  const { t } = useTranslation();
  const access = useEtaAccess();
  const [tab, setTab] = useState<'documents' | 'settings' | 'codes'>('documents');

  if (!access.loaded) {
    return <Loading />;
  }
  if (!access.read) {
    return (
      <p role="status" className="text-sm text-content-muted">
        {t('eta.unavailable')}
      </p>
    );
  }
  const tabs = access.configure
    ? (['documents', 'settings', 'codes'] as const)
    : (['documents'] as const);
  return (
    <div className="flex flex-col gap-6 text-start">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('eta.title')}</h1>
        <p className="text-sm text-content-muted">{t('eta.subtitle')}</p>
      </header>
      {access.sign ? <SigningQueueLink /> : null}
      {tabs.length > 1 ? (
        <div role="tablist" aria-label={t('eta.title')} className="flex flex-wrap gap-2">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? buttonClass.primary : buttonClass.secondary}
              onClick={() => setTab(key)}
            >
              {t(`eta.tabs.${key}`)}
            </button>
          ))}
        </div>
      ) : null}
      {tab === 'documents' ? <EtaDocumentList /> : null}
      {tab === 'settings' && access.configure ? <EtaSettingsPanel /> : null}
      {tab === 'codes' && access.configure ? <EtaCodesPanel /> : null}
    </div>
  );
}

function SigningQueueLink() {
  const { t } = useTranslation();
  const { paths, navigate } = useOperations();
  if (paths.etaSigning === undefined) {
    return <p className="text-sm text-content-muted">{t('eta.agent.desktopOnly')}</p>;
  }
  const to = paths.etaSigning;
  return (
    <p>
      <a
        href={to}
        className={buttonClass.secondary}
        onClick={(event) => {
          event.preventDefault();
          navigate(to);
        }}
      >
        {t('eta.agent.open')}
      </a>
    </p>
  );
}

function EtaDocumentList() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const [state, setState] = useState<EtaDocumentState | ''>('');
  const list = useInfiniteQuery({
    queryKey: keys.etaDocuments({ state }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/eta/documents', {
          params: {
            query: {
              limit: 50,
              ...(state === '' ? {} : { state }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  return (
    <section className={cardClass} aria-labelledby="eta-documents">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="eta-documents" className="text-base font-semibold text-content">
          {t('eta.list.title')}
        </h2>
        <Field label={t('eta.list.filter')} className="w-56">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={state}
              onChange={(event) => setState(event.target.value as EtaDocumentState | '')}
            >
              <option value="">{t('eta.list.all')}</option>
              {ETA_DOCUMENT_STATES.map((value) => (
                <option key={value} value={value}>
                  {t(`eta.state.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {list.isPending ? <Loading /> : null}
      {list.isError ? <Failure error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.data === undefined ? null : list.data.pages[0]?.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('eta.list.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-content-muted">
              <th className="py-2 text-start font-medium">{t('eta.list.internalId')}</th>
              <th className="py-2 text-start font-medium">{t('eta.list.state')}</th>
              <th className="py-2 text-start font-medium">{t('eta.list.environment')}</th>
              <th className="py-2 text-end font-medium">{t('eta.list.total')}</th>
              <th className="py-2 text-start font-medium">{t('eta.list.prepared')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {list.data.pages.flatMap((page) =>
              page.items.map((document) => (
                <tr key={document.id}>
                  <td className="py-2">
                    <a
                      href={paths.etaDocument(document.id)}
                      dir="ltr"
                      className="text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.etaDocument(document.id));
                      }}
                    >
                      {document.internalId}
                    </a>
                    <span className="ms-1 text-xs text-content-muted">#{document.sequence}</span>
                  </td>
                  <td className="py-2">
                    <EtaStateBadge state={document.state} />
                  </td>
                  <td className="py-2">{t(`eta.environment.${document.environment}`)}</td>
                  <td className="py-2 text-end tabular-nums">
                    {formatAmount(document.totalAmount, document.currencyCode, locale)}
                  </td>
                  <td className="py-2 text-content-muted">
                    {formatDateTime(document.preparedAt, { locale })}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      {list.hasNextPage ? (
        <div>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('eta.list.more')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
