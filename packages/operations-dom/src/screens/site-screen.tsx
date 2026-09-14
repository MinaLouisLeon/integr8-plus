import type { paths } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AccessNotesPanel } from '../access-notes.js';
import { keys, useOperations } from '../api.js';
import { SiteLocation } from '../site-location.js';
import {
  addressText,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  StateBadge,
  when,
} from '../ui.js';
import {
  AddressFields,
  addressDraft,
  toAddressBody,
  type AddressDraft,
} from './customer-fields.js';

type SiteChanges = NonNullable<
  paths['/v1/sites/{siteId}']['patch']['requestBody']
>['content']['application/json'];

/**
 * A site: how to get in, where it is, who to call, and the jobs done there.
 *
 * Access notes come first here as on a job, and can be corrected by the office
 * or by anyone working a job at the site.
 */
export function SiteScreen({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useOperations();
  const [editing, setEditing] = useState<{ name: string; address: AddressDraft } | undefined>(
    undefined,
  );

  const detail = useQuery({
    queryKey: keys.site(siteId),
    queryFn: async () =>
      (await client.GET('/v1/sites/{siteId}', { params: { path: { siteId } } })).data!,
  });
  const update = useMutation({
    mutationFn: async (body: SiteChanges) =>
      (await client.PATCH('/v1/sites/{siteId}', { params: { path: { siteId } }, body })).data!,
    onSuccess: () => {
      setEditing(undefined);
      void detail.refetch();
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return <Failure error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const { site, customer, contact, recentWorkOrders, can } = detail.data;

  return (
    <div className="flex flex-col gap-6 text-start">
      <a
        href={paths.customer(customer.id)}
        className="text-sm text-accent underline-offset-4 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.customer(customer.id));
        }}
      >
        <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
          ←
        </span>{' '}
        {t('operations.site.back', { name: customer.name })}
      </a>

      <AccessNotesPanel
        access={site.access}
        locale={locale}
        {...(can.editAccess
          ? {
              onSave: async (input) => {
                await client.PUT('/v1/sites/{siteId}/access', {
                  params: { path: { siteId } },
                  body: input,
                });
                await detail.refetch();
              },
            }
          : {})}
      />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">
            {site.name}
            {site.archived ? (
              <span className="ms-2 text-sm text-content-muted">
                ({t('operations.site.archived')})
              </span>
            ) : null}
          </h1>
          <p dir="auto" className="text-sm text-content-muted">
            {addressText(site.address)}
          </p>
        </div>
        {can.edit ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setEditing({ name: site.name, address: addressDraft(site.address) })}
            >
              {t('operations.site.edit')}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={update.isPending}
              onClick={() => update.mutate({ archived: !site.archived })}
            >
              {site.archived ? t('operations.site.restore') : t('operations.site.archive')}
            </button>
          </div>
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="location-heading" className={cardClass}>
          <h2 id="location-heading" className="text-lg font-semibold text-content">
            {t('operations.location.title')}
          </h2>
          <SiteLocation
            key={`${String(site.location?.latitude)}-${String(site.location?.longitude)}-${site.geocodeStatus}`}
            location={site.location}
            status={site.geocodeStatus}
            accuracy={site.geocodeAccuracy}
            editable={can.edit}
            onSave={async (location) => {
              await update.mutateAsync({ location });
            }}
          />
        </section>

        <section aria-labelledby="contact-heading" className={cardClass}>
          <h2 id="contact-heading" className="text-lg font-semibold text-content">
            {t('operations.site.contact')}
          </h2>
          {contact === null ? (
            <p className="text-sm text-content-muted">{t('operations.site.noContact')}</p>
          ) : (
            <p className="flex flex-col text-sm text-content">
              <span className="font-medium">{contact.name}</span>
              {[contact.jobTitle, contact.phone, contact.email]
                .filter((value): value is string => value !== null)
                .map((value) => (
                  <span key={value} dir="ltr" className="text-content-muted">
                    {value}
                  </span>
                ))}
            </p>
          )}
        </section>
      </div>

      <section aria-labelledby="site-jobs-heading" className={cardClass}>
        <h2 id="site-jobs-heading" className="text-lg font-semibold text-content">
          {t('operations.site.recentJobs')}
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
                  {job.referenceLabel} · {job.title}
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
          title={t('operations.site.edit')}
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
                disabled={
                  editing.name.trim() === '' ||
                  editing.address.line1.trim() === '' ||
                  update.isPending
                }
                onClick={() =>
                  update.mutate({
                    name: editing.name,
                    address: {
                      ...toAddressBody(editing.address),
                      line1: editing.address.line1.trim(),
                    },
                  })
                }
              >
                {t('operations.site.save')}
              </button>
            </>
          }
        >
          <Field label={t('operations.site.name')}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            )}
          </Field>
          <AddressFields
            value={editing.address}
            onChange={(address) => setEditing({ ...editing, address })}
            lineRequired
          />
          {update.isError ? <Failure error={update.error} /> : null}
        </Dialog>
      )}
    </div>
  );
}
