import { ApiRequestError } from '@integr8/api-client';
import { apiErrorMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate } from 'react-router';
import { useShellChrome } from '~/components/shell-chrome';
import { Button, ErrorState, LoadingState, Shell } from '~/components/ui';
import { useMe } from '~/features/forms/api';
import { session } from '~/lib/session';

/**
 * Integr8's switch for this company's e-invoicing (ADR-0014).
 *
 * A staff seat only (`eta.switch`): a company never turns e-invoicing on for
 * itself, and it stays off until Integr8 has tested it with the tax
 * authority. Anybody else is sent to the dashboard. Both directions ask
 * first, in place, since either one changes what the company's people see.
 *
 * The screen also says what the server lacks. None of it stops the switch:
 * without `ETA_CREDENTIALS_KEY` a company can be switched on and look around,
 * it just cannot save its tax authority credentials yet.
 */

const AVAILABILITY_KEY = ['eta', 'availability'] as const;

export function EInvoicingSwitchRoute() {
  const { t } = useTranslation();
  const me = useMe();
  useShellChrome({ title: t('eta.switch.title') });
  const allowed = me.data?.permissions.includes('eta.switch') === true;
  const availability = useQuery({
    queryKey: AVAILABILITY_KEY,
    enabled: allowed,
    queryFn: async () => (await session().client.GET('/v1/eta/availability')).data!,
  });

  if (me.isPending || (allowed && availability.isPending)) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  const failure = me.error ?? availability.error;
  if (failure !== null) {
    return (
      <Shell>
        <ErrorState
          requestId={failure instanceof ApiRequestError ? failure.requestId : undefined}
          onRetry={() => void (me.isError ? me.refetch() : availability.refetch())}
        />
      </Shell>
    );
  }
  if (!allowed || availability.data === undefined) {
    return <Navigate to="/dashboard" replace />;
  }
  return <SwitchPanel state={availability.data} />;
}

export interface Availability {
  enabled: boolean;
  financeEnabled: boolean;
  active: boolean;
  server: { credentialsKeyConfigured: boolean; productionAllowed: boolean };
}

export function SwitchPanel({ state }: { state: Availability }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const next = !state.enabled;

  const change = useMutation({
    mutationFn: async (enabled: boolean) =>
      (await session().client.PUT('/v1/eta/availability', { body: { enabled } })).data!,
    onSuccess: (updated) => {
      queries.setQueryData(AVAILABILITY_KEY, updated);
      setConfirming(false);
      setSaved(true);
      // The menu and every e-invoicing screen read the company's modules
      // from `/v1/me` and from the e-invoicing queries.
      void queries.invalidateQueries({ queryKey: ['me'] });
      void queries.invalidateQueries({ queryKey: ['eta'] });
    },
  });

  const status = !state.enabled
    ? t('eta.switch.statusOff')
    : state.active
      ? t('eta.switch.statusOn')
      : t('eta.switch.statusOnInactive');

  return (
    <Shell>
      <div className="flex flex-col gap-6 px-6 py-8 text-start">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('eta.switch.title')}</h1>
          <p className="text-sm text-content-muted">{t('eta.switch.intro')}</p>
        </header>

        <p
          role="note"
          className="rounded-md border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          {t('eta.switch.notReady')}
        </p>

        <section
          aria-labelledby="eta-switch-status"
          className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="eta-switch-status" className="text-base font-semibold text-content">
              {state.enabled ? t('eta.switch.on') : t('eta.switch.off')}
            </h2>
            {confirming ? null : (
              <Button
                variant={state.enabled ? 'secondary' : 'primary'}
                onClick={() => {
                  setSaved(false);
                  change.reset();
                  setConfirming(true);
                }}
              >
                {state.enabled ? t('eta.switch.turnOff') : t('eta.switch.turnOn')}
              </Button>
            )}
          </div>
          <p role="status" className="text-sm text-content">
            {status}
            {saved ? ` ${t('eta.switch.saved')}` : ''}
          </p>

          {confirming ? (
            <div
              role="alertdialog"
              aria-labelledby="eta-switch-confirm"
              className="flex flex-col gap-3 rounded-md border border-border-subtle bg-surface-muted p-3"
            >
              <h3 id="eta-switch-confirm" className="text-sm font-semibold text-content">
                {next ? t('eta.switch.confirmOnTitle') : t('eta.switch.confirmOffTitle')}
              </h3>
              <p className="text-sm text-content">
                {next ? t('eta.switch.confirmOn') : t('eta.switch.confirmOff')}
              </p>
              {change.error === null ? null : (
                <p role="alert" className="text-sm text-danger">
                  {apiErrorMessage(change.error, t)}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button busy={change.isPending} onClick={() => change.mutate(next)}>
                  {t('eta.switch.confirm')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={change.isPending}
                  onClick={() => setConfirming(false)}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <ul className="flex list-disc flex-col gap-2 ps-5 text-sm text-content-muted">
          {state.financeEnabled ? null : <li>{t('eta.switch.financeOff')}</li>}
          <li>
            {state.server.credentialsKeyConfigured
              ? t('eta.switch.keyPresent')
              : t('eta.switch.keyMissing')}
          </li>
          {state.server.productionAllowed ? null : <li>{t('eta.switch.productionLocked')}</li>}
        </ul>
      </div>
    </Shell>
  );
}
