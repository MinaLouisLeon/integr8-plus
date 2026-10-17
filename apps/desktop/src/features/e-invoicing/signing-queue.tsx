import {
  type DigestSigner,
  inspectForSigning,
  SigningRefusedError,
  type SigningSummary,
} from '@integr8/eta';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { BackLink, useEtaAccess, useOperations } from '@integr8/operations-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * The signing agent (docs/e-invoicing PLAN §4): the company's signing
 * requests, each claimed, checked here and shown before anyone signs.
 *
 * What is shown is read from the document that would be signed, after its
 * canonical digest is recomputed on this computer and compared with the
 * request's: a server that asked for one thing and sent another is refused
 * here, before any token is touched.
 *
 * No hardware signer ships in this build (PLAN §9): it needs the token's
 * model, its PKCS#11 or CNG middleware and the operating system, none of
 * which are known yet. `SIGNER` is where one plugs in; until then the
 * request is checked and left unsigned, and the screen says so.
 */
const SIGNER: DigestSigner | null = null;

const card = 'flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4 text-start';
const secondary =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60';
const primary =
  'inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60';

type Checked =
  { ok: true; summary: SigningSummary } | { ok: false; reason: SigningRefusedError['reason'] };

export function EtaSigningQueue() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const access = useEtaAccess();
  const [checked, setChecked] = useState<Checked | null>(null);

  const queue = useQuery({
    queryKey: ['eta', 'signing-queue'],
    enabled: access.sign,
    refetchInterval: 15_000,
    queryFn: async () => (await client.GET('/v1/eta/signing-requests')).data!,
  });

  const review = useMutation({
    mutationFn: async (requestId: string): Promise<Checked> => {
      const claimed = (
        await client.POST('/v1/eta/signing-requests/{requestId}/claim', {
          params: { path: { requestId } },
        })
      ).data!;
      try {
        return {
          ok: true,
          summary: await inspectForSigning(claimed.request, claimed.documentText),
        };
      } catch (error) {
        if (error instanceof SigningRefusedError) {
          return { ok: false, reason: error.reason };
        }
        throw error;
      }
    },
    onSuccess: (result) => {
      setChecked(result);
      void queries.invalidateQueries({ queryKey: ['eta', 'signing-queue'] });
    },
  });

  if (!access.loaded) {
    return null;
  }
  if (!access.sign) {
    return <p className="text-sm text-content-muted">{t('eta.unavailable')}</p>;
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <nav>
        <BackLink to={paths.eInvoicing} label={t('eta.back')} />
      </nav>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('eta.agent.title')}</h1>
        <p className="text-sm text-content-muted">{t('eta.agent.intro')}</p>
      </header>

      {queue.data === undefined ? null : queue.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('eta.agent.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface text-sm">
          {queue.data.items.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>
                <span dir="ltr" className="font-medium">
                  {request.internalId}
                </span>
                <span className="ms-2 text-content-muted">
                  {t(`eta.environment.${request.environment}`)} ·{' '}
                  {t('eta.agent.expires', {
                    date: formatDateTime(request.expiresAt, { locale }),
                  })}
                </span>
              </span>
              <button
                type="button"
                className={secondary}
                disabled={review.isPending}
                onClick={() => review.mutate(request.id)}
              >
                {t('eta.agent.review')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {checked === null ? null : checked.ok ? (
        <section className={card} aria-labelledby="eta-agent-summary">
          <h2 id="eta-agent-summary" className="text-base font-semibold text-content">
            {checked.summary.internalId}
          </h2>
          <p role="status" className="text-sm text-content">
            {t('eta.agent.checked')}
          </p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-content-muted">{t('eta.agent.summary.documentType')}</dt>
            <dd dir="ltr">{checked.summary.documentType}</dd>
            <dt className="text-content-muted">{t('eta.agent.summary.issuedAt')}</dt>
            <dd dir="ltr">{checked.summary.issuedAt}</dd>
            <dt className="text-content-muted">{t('eta.agent.summary.issuer')}</dt>
            <dd dir="auto">
              {checked.summary.issuerName} ({checked.summary.issuerId})
            </dd>
            <dt className="text-content-muted">{t('eta.agent.summary.receiver')}</dt>
            <dd dir="auto">
              {checked.summary.receiverName}
              {checked.summary.receiverId === null ? '' : ` (${checked.summary.receiverId})`}
            </dd>
            <dt className="text-content-muted">{t('eta.agent.summary.total')}</dt>
            <dd dir="ltr" className="tabular-nums">
              {checked.summary.totalAmount}
            </dd>
            <dt className="text-content-muted">{t('eta.agent.summary.environment')}</dt>
            <dd>{t(`eta.environment.${checked.summary.environment}`)}</dd>
          </dl>
          {SIGNER === null ? (
            <p
              role="alert"
              className="rounded-md border border-warning bg-warning-subtle p-3 text-sm text-content"
            >
              {t('eta.agent.noSigner')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} disabled>
              {t('eta.agent.sign')}
            </button>
            <button type="button" className={secondary} onClick={() => setChecked(null)}>
              {t('eta.agent.close')}
            </button>
          </div>
        </section>
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
        >
          {t(`eta.agent.refused.${checked.reason}`)}
        </p>
      )}
    </div>
  );
}
