import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type StockLocation, useOperations } from '../api.js';
import { memberName, useMembers } from '../crm/lead-parts.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import { LocationKindBadge, useLocations } from './inventory-parts.js';

/**
 * Where stock is (CRM/ERP plan, phase E1): warehouses, the engineers' vans
 * and customer sites. Vans are assigned here; a site location is made from
 * the API (its site has to be chosen from the customer's sites), not from this
 * screen yet.
 */
export function LocationListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    kind: 'warehouse' as 'warehouse' | 'van',
    assignedTo: '',
  });
  const locations = useLocations(includeArchived);
  const members = useMembers();
  const rowMenu = useRowMenu();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManage = me.data?.permissions.includes('inventory.manage') ?? false;

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/inventory/locations', {
          body: {
            name: draft.name.trim(),
            kind: draft.kind,
            ...(draft.kind === 'van' && draft.assignedTo !== ''
              ? { assignedTo: draft.assignedTo }
              : {}),
          },
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['inventory'] });
      navigate(paths.stockLocation(created.id));
    },
  });

  const groups = (['warehouse', 'van', 'site'] as const).map((kind) => ({
    kind,
    items: (locations.data ?? []).filter((location) => location.kind === kind),
  }));

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('inventory.locations.title')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            {t('inventory.locations.includeArchived')}
          </label>
          {canManage ? (
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => {
                create.reset();
                setDraft({ name: '', kind: 'warehouse', assignedTo: '' });
                setCreating(true);
              }}
            >
              {t('inventory.locations.new')}
            </button>
          ) : null}
        </div>
      </header>

      {locations.isPending ? (
        <Loading />
      ) : locations.isError ? (
        <Failure error={locations.error} onRetry={() => void locations.refetch()} />
      ) : locations.data.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('inventory.locations.empty')}
        </p>
      ) : (
        groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <section
              key={group.kind}
              aria-labelledby={`locations-${group.kind}`}
              className="flex flex-col gap-2"
            >
              <h2 id={`locations-${group.kind}`} className="text-base font-semibold text-content">
                {t(`inventory.locationKind.${group.kind}`)}
              </h2>
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
                {group.items.map((location) => (
                  <Row
                    key={location.id}
                    location={location}
                    assignee={memberName(members.data, location.assignedTo)}
                    rowMenu={rowMenu}
                  />
                ))}
              </ul>
            </section>
          ))
      )}

      {creating ? (
        <Dialog
          title={t('inventory.locations.new')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setCreating(false)}
              >
                {t('inventory.items.cancel')}
              </button>
              <button
                type="submit"
                form="inventory-new-location"
                className={buttonClass.primary}
                disabled={draft.name.trim() === '' || create.isPending}
              >
                {create.isPending ? t('inventory.items.creating') : t('inventory.locations.create')}
              </button>
            </>
          }
        >
          <form
            id="inventory-new-location"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.name.trim() !== '') {
                create.mutate();
              }
            }}
          >
            <Field label={t('inventory.locations.fields.name')}>
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={100}
                  className={inputClass}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('inventory.locations.fields.kind')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft({ ...draft, kind: event.target.value as 'warehouse' | 'van' })
                  }
                >
                  <option value="warehouse">{t('inventory.locationKind.warehouse')}</option>
                  <option value="van">{t('inventory.locationKind.van')}</option>
                </select>
              )}
            </Field>
            {draft.kind === 'van' ? (
              <Field
                label={t('inventory.locations.fields.assignedTo')}
                hint={t('inventory.locations.vanHint')}
              >
                {(id, describedBy) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    className={inputClass}
                    value={draft.assignedTo}
                    onChange={(event) => setDraft({ ...draft, assignedTo: event.target.value })}
                  >
                    <option value="">{t('inventory.locations.unassigned')}</option>
                    {(members.data ?? [])
                      .filter((member) => member.status === 'active')
                      .map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            ) : null}
            {create.isError ? <Failure error={create.error} /> : null}
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}

function Row({
  location,
  assignee,
  rowMenu,
}: {
  location: StockLocation;
  assignee: string | null;
  rowMenu: ReturnType<typeof useRowMenu>;
}) {
  const { t } = useTranslation();
  const { navigate, paths } = useOperations();
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      onContextMenu={rowMenu(
        { kind: 'stockLocation', id: location.id, label: location.name },
        () => [
          {
            key: 'open',
            label: t('operations.rowActions.open'),
            onSelect: () => navigate(paths.stockLocation(location.id)),
          },
        ],
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <a
          href={paths.stockLocation(location.id)}
          className="truncate font-medium text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.stockLocation(location.id));
          }}
        >
          {location.name}
        </a>
        <span className="truncate text-sm text-content-muted">
          {location.kind === 'van'
            ? (assignee ?? t('inventory.locations.unassigned'))
            : (location.site?.name ?? '')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {location.archivedAt === null ? null : (
          <span className="text-xs text-content-muted">{t('inventory.locations.archived')}</span>
        )}
        <LocationKindBadge kind={location.kind} />
      </div>
    </li>
  );
}
