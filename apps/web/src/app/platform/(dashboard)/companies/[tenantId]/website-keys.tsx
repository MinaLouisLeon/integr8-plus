'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * A company's website keys (docs/documents ADR-0001 D10, D11).
 *
 * Everybody on the dashboard sees which keys exist, their last characters and
 * how much they are used. Only a staff manager — the account the terminal
 * command made — can make or revoke one, and a new key is shown once, here,
 * until it is dismissed: nothing can fetch it again.
 */
export function WebsiteKeysPanel({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const queryKey = ['platform', 'company', tenantId, 'website-keys'];

  const keys = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await platformClient().GET('/v1/platform/companies/{tenantId}/website-keys', {
          params: { path: { tenantId } },
        })
      ).data!,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await platformClient().POST('/v1/platform/companies/{tenantId}/website-keys', {
          params: { path: { tenantId } },
          body: { label: label.trim() === '' ? null : label.trim() },
        })
      ).data!,
    onSuccess: (made) => {
      setSecret(made.secret);
      setCopied(false);
      setLabel('');
      void queries.invalidateQueries({ queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: async (keyId: string) =>
      (
        await platformClient().DELETE('/v1/platform/companies/{tenantId}/website-keys/{keyId}', {
          params: { path: { tenantId, keyId } },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey }),
  });

  const title = t('documents.keys.title');
  if (keys.isPending) {
    return (
      <Panel title={title}>
        <LoadingState />
      </Panel>
    );
  }
  if (keys.isError) {
    return (
      <Panel title={title}>
        <ErrorState
          requestId={keys.error instanceof ApiRequestError ? keys.error.requestId : undefined}
          onRetry={() => void keys.refetch()}
        />
      </Panel>
    );
  }

  const { items, canManage, maxLive } = keys.data;
  const live = items.filter((key) => key.revokedAt === null).length;
  const locale = i18n.language;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? '');
      setCopied(true);
    } catch {
      // The key is on screen to select by hand.
      setCopied(false);
    }
  };

  return (
    <Panel title={title} description={t('documents.keys.description')}>
      {secret === null ? null : (
        <section
          aria-labelledby="website-key-secret"
          className="flex flex-col gap-3 rounded-md border border-warning bg-warning-subtle p-4"
        >
          <h3 id="website-key-secret" className="font-semibold text-content">
            {t('documents.keys.secretTitle')}
          </h3>
          <p className="text-sm text-content">{t('documents.keys.secretBody')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              dir="ltr"
              className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1 text-content"
            >
              {secret}
            </code>
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? t('documents.keys.copied') : t('documents.keys.copy')}
            </Button>
          </div>
          <div>
            <Button onClick={() => setSecret(null)}>{t('documents.keys.done')}</Button>
          </div>
        </section>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('documents.keys.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {items.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="flex flex-wrap items-center gap-2 font-medium text-content">
                  <span dir="ltr">{t('documents.keys.endsWith', { hint: key.hint })}</span>
                  {key.label === null ? null : <span dir="auto">· {key.label}</span>}
                  {key.revokedAt === null ? (
                    <Badge tone="ok">{t('documents.keys.live')}</Badge>
                  ) : (
                    <Badge tone="muted">
                      {t('documents.keys.revoked', { date: formatWhen(key.revokedAt, locale) })}
                    </Badge>
                  )}
                </span>
                <span className="text-content-muted">
                  {t('documents.keys.made', {
                    date: formatWhen(key.createdAt, locale),
                    name: key.createdBy,
                  })}
                  {' · '}
                  {key.lastUsedAt === null
                    ? t('documents.keys.neverUsed')
                    : t('documents.keys.lastUsed', { date: formatWhen(key.lastUsedAt, locale) })}
                  {' · '}
                  {t('documents.keys.usage', { lookups: key.lookups, found: key.found })}
                </span>
              </div>
              {canManage && key.revokedAt === null ? (
                <Button
                  variant="danger"
                  busy={revoke.isPending && revoke.variables === key.id}
                  onClick={() => {
                    if (window.confirm(t('documents.keys.revokeConfirm'))) {
                      revoke.mutate(key.id);
                    }
                  }}
                >
                  {t('documents.keys.revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {revoke.isError ? (
        <p role="alert" className="text-sm text-danger">
          {messageForError(revoke.error, t)}
        </p>
      ) : null}

      {!canManage ? (
        <p className="text-sm text-content-muted">{t('documents.keys.managerOnly')}</p>
      ) : live >= maxLive ? (
        <p className="text-sm text-content-muted">{t('documents.keys.limit')}</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field
              label={t('documents.keys.label')}
              maxLength={80}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              {...(create.isError ? { error: messageForError(create.error, t) } : {})}
            />
          </div>
          <Button type="submit" busy={create.isPending}>
            {t('documents.keys.create')}
          </Button>
        </form>
      )}
    </Panel>
  );
}
