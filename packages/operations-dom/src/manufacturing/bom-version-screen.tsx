import { formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from '../api.js';
import { KindBadge } from '../inventory/inventory-parts.js';
import { BackLink, Loading } from '../ui.js';
import { BomComponents } from './bom-screen.js';
import { AppLink, ManufacturingFailure, ManufacturingGate } from './manufacturing-parts.js';

/**
 * One version of a bill of materials, by its id (seventh round's follow-up;
 * ADR-0012): reached from the item's bill history and from an order built
 * from it. Read-only — a version is never changed, a new one is saved.
 */
export function BomVersionScreen({ bomId }: { bomId: string }) {
  return (
    <ManufacturingGate>
      <BomVersion bomId={bomId} />
    </ManufacturingGate>
  );
}

function BomVersion({ bomId }: { bomId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const bom = useQuery({
    queryKey: keys.bomVersion(bomId),
    queryFn: async () =>
      (await client.GET('/v1/manufacturing/boms/{bomId}', { params: { path: { bomId } } })).data!,
  });

  if (bom.isPending) {
    return (
      <div className="flex flex-col gap-4 text-start">
        <BackLink to={paths.boms} label={t('manufacturing.boms.back')} />
        <Loading />
      </div>
    );
  }
  if (bom.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        <BackLink to={paths.boms} label={t('manufacturing.boms.back')} />
        <ManufacturingFailure error={bom.error} onRetry={() => void bom.refetch()} />
      </div>
    );
  }

  const version = bom.data;
  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.bom(version.item.id)} label={t('manufacturing.bom.backToBill')} />
      <header className="flex flex-col gap-2">
        <p className="text-sm text-content-muted">{t('manufacturing.bom.heading')}</p>
        <h1 className="text-2xl font-semibold break-words text-content">
          {t('manufacturing.bom.versionTitle', {
            item: version.item.name,
            version: formatNumber(version.version, { locale }),
          })}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
          <span dir="ltr">{version.item.sku}</span>
          <KindBadge kind={version.item.kind} />
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
              version.superseded
                ? 'border-border-subtle text-content-muted'
                : 'border-accent text-content'
            }`}
          >
            {version.superseded
              ? t('manufacturing.bom.superseded')
              : t('manufacturing.bom.current')}
          </span>
          <AppLink to={paths.item(version.item.id)}>{t('manufacturing.bom.openItem')}</AppLink>
        </div>
        <p className="text-sm text-content-muted">
          {t('manufacturing.bom.savedBy', {
            name: version.createdBy.name,
            date: formatDateTime(version.createdAt, { locale }),
          })}
        </p>
        <p
          role="note"
          className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-content"
        >
          {version.superseded
            ? t('manufacturing.bom.versionReadOnly')
            : t('manufacturing.bom.versionInUse')}
        </p>
      </header>
      <BomComponents bom={version} />
    </div>
  );
}
