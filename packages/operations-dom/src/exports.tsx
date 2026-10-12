import { formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation } from '@tanstack/react-query';
import { useOperations } from './api.js';
import { buttonClass, Failure, usePermissions } from './ui.js';

/**
 * Audited CSV exports (eighth round; ADR-0012): leads, opportunities, stock
 * movements and parts used. Each is a GET the server records with the filters
 * it used; the file is saved the way every other download is, through the
 * app's `download`. A button shows only to a seat holding the export's
 * permission, and says so when the server stopped at its row limit.
 */

/** The most rows an export carries; `x-export-truncated` says when more matched. */
export const EXPORT_ROW_LIMIT = 50_000;

/** What an openapi-fetch GET with `parseAs: 'blob'` resolves to. */
interface CsvResponse {
  data?: unknown;
  response: Response;
}

export function CsvExportButton({
  permission,
  label,
  filename,
  request,
  className = 'items-start',
}: {
  /** The permission the export needs; without it, nothing is shown. */
  permission: string;
  label: string;
  filename: string;
  request: () => Promise<CsvResponse>;
  className?: string;
}) {
  const permissions = usePermissions();
  if (!permissions.includes(permission)) {
    return null;
  }
  return (
    <ExportControl label={label} filename={filename} request={request} className={className} />
  );
}

function ExportControl({
  label,
  filename,
  request,
  className,
}: {
  label: string;
  filename: string;
  request: () => Promise<CsvResponse>;
  className: string;
}) {
  const { t } = useTranslation();
  const { download, locale } = useOperations();
  const run = useMutation({
    mutationFn: async () => {
      const { data, response } = await request();
      download(data as Blob, filename);
      return response.headers.get('x-export-truncated') === 'true';
    },
  });
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <button
        type="button"
        className={buttonClass.secondary}
        disabled={run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending ? t('analytics.export.preparing') : label}
      </button>
      <p role="status" className="text-sm text-content empty:hidden">
        {run.data === true
          ? t('analytics.export.truncated', {
              rows: formatNumber(EXPORT_ROW_LIMIT, { locale }),
            })
          : ''}
      </p>
      {run.isError ? <Failure error={run.error} /> : null}
    </div>
  );
}

/**
 * Stock movements as CSV, for those who move stock (`inventory.move`), with
 * whatever filters the screen it sits on has. Exported for the inventory
 * screens to place beside their movement lists.
 */
export function StockMovementsExportButton({
  filters = {},
  className,
}: {
  filters?: {
    from?: string;
    to?: string;
    itemId?: string;
    locationId?: string;
  };
  className?: string;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  return (
    <CsvExportButton
      permission="inventory.move"
      label={t('analytics.export.movements')}
      filename="stock-movements.csv"
      {...(className === undefined ? {} : { className })}
      request={() =>
        client.GET('/v1/inventory/movements.csv', {
          params: { query: filters },
          parseAs: 'blob',
        })
      }
    />
  );
}
