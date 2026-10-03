import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Failure, Field, inputClass, Loading, when } from '../ui.js';

type Kind = 'customers' | 'sites' | 'work_orders';

/**
 * Bringing customers, sites and jobs in from a spreadsheet.
 *
 * The file is read in the background, each row on its own. What could not be
 * imported is listed by spreadsheet row and column, so the person fixes those
 * rows and imports just them again — nothing else in the file was held back.
 */
export function ImportsScreen() {
  const { t } = useTranslation();
  const { client, download, locale, timeZone } = useOperations();
  const queryClient = useQueryClient();
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [kind, setKind] = useState<Kind>('customers');
  const [file, setFile] = useState<File | null>(null);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const fileId = useId();

  const columns = useQuery({
    queryKey: keys.columns(kind),
    queryFn: async () =>
      (await client.GET('/v1/imports/columns/{kind}', { params: { path: { kind } } })).data!.items,
  });
  const recent = useQuery({
    queryKey: keys.imports,
    queryFn: async () => (await client.GET('/v1/imports')).data!.items,
    refetchInterval: (query) =>
      query.state.data?.some(
        (entry) => entry.status === 'pending' || entry.status === 'running',
      ) === true
        ? 1500
        : false,
  });

  const start = useMutation({
    mutationFn: async () => {
      if (file === null) {
        throw new Error('No file');
      }
      return (
        await client.POST('/v1/imports', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { kind, fileName: file.name, csv: await file.text(), timeZone: zone },
        })
      ).data!;
    },
    onSuccess: (record) => {
      setOpened(record.id);
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: keys.imports });
    },
  });

  const template = async () => {
    const { data } = await client.GET('/v1/imports/templates/{kind}', {
      params: { path: { kind } },
      parseAs: 'blob',
    });
    download(data as unknown as Blob, `${kind}-template.csv`);
  };

  return (
    <div className="flex flex-col gap-6 text-start">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('operations.imports.title')}</h1>
        <p className="text-sm text-content-muted">{t('operations.imports.intro')}</p>
      </header>

      <form
        className={cardClass}
        aria-label={t('operations.imports.title')}
        onSubmit={(event) => {
          event.preventDefault();
          start.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
          <Field label={t('operations.imports.kind')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={kind}
                onChange={(event) => setKind(event.target.value as Kind)}
              >
                {(['customers', 'sites', 'work_orders'] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`operations.imports.kinds.${option}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div>
            <button type="button" className={buttonClass.secondary} onClick={() => void template()}>
              {t('operations.imports.template')}
            </button>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={fileId} className="text-sm font-medium text-content">
              {t('operations.imports.file')}
            </label>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv"
              className="text-sm text-content"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={file === null || start.isPending}
              aria-busy={start.isPending}
            >
              {t('operations.imports.start')}
            </button>
          </div>
        </div>
        <p className="text-xs text-content-muted">{t('operations.imports.timeZone', { zone })}</p>
        {start.isError ? <Failure error={start.error} /> : null}

        <details>
          <summary className="cursor-pointer text-sm font-medium text-content">
            {t('operations.imports.columns')}
          </summary>
          {columns.data === undefined ? null : (
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
              {columns.data.map((column) => (
                <div key={column.name}>
                  <dt className="font-mono text-content">
                    {column.name}
                    {column.required ? (
                      <span className="ms-1 text-xs text-danger">
                        ({t('operations.imports.requiredColumn')})
                      </span>
                    ) : null}
                  </dt>
                  <dd className="text-content-muted">{column.description}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      </form>

      {opened === undefined ? null : <ImportReport importId={opened} />}

      <section aria-labelledby="recent-imports" className={cardClass}>
        <h2 id="recent-imports" className="text-lg font-semibold text-content">
          {t('operations.imports.recent')}
        </h2>
        {recent.isPending ? (
          <Loading />
        ) : recent.isError ? (
          <Failure error={recent.error} />
        ) : recent.data.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.imports.noImports')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {recent.data.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="text-content">
                    {entry.fileName} · {t(`operations.imports.kinds.${entry.kind}`)}
                  </span>
                  <span className="text-xs text-content-muted">
                    {t(`operations.imports.status.${entry.status}`)} ·{' '}
                    {t('operations.imports.summary', {
                      succeeded: entry.succeededRows,
                      failed: entry.failedRows,
                    })}{' '}
                    · {when(entry.createdAt, locale)}
                  </span>
                </span>
                <button
                  type="button"
                  className={buttonClass.ghost}
                  onClick={() => setOpened(entry.id)}
                >
                  {t('operations.imports.open')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ImportReport({ importId }: { importId: string }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const report = useQuery({
    queryKey: keys.import(importId),
    queryFn: async () =>
      (await client.GET('/v1/imports/{importId}', { params: { path: { importId } } })).data!,
    refetchInterval: (query) =>
      query.state.data === undefined ||
      query.state.data.status === 'pending' ||
      query.state.data.status === 'running'
        ? 1000
        : false,
  });

  if (report.isPending) {
    return <Loading />;
  }
  if (report.isError) {
    return <Failure error={report.error} />;
  }
  const data = report.data;
  const done = data.succeededRows + data.failedRows;
  const finished = data.status === 'completed' || data.status === 'failed';

  return (
    <section aria-labelledby="import-report" className={cardClass} aria-busy={!finished}>
      <h2 id="import-report" className="text-lg font-semibold text-content">
        {data.fileName} — {t(`operations.imports.status.${data.status}`)}
      </h2>
      <div role="status" className="flex flex-col gap-2">
        {data.totalRows > 0 ? (
          <>
            <progress
              max={data.totalRows}
              value={done}
              className="w-full"
              aria-label={t('operations.imports.progress', { done, total: data.totalRows })}
            />
            <p className="text-sm text-content">
              {t('operations.imports.progress', { done, total: data.totalRows })}
            </p>
          </>
        ) : null}
        {finished ? (
          <p className="text-sm font-medium text-content">
            {t('operations.imports.summary', {
              succeeded: data.succeededRows,
              failed: data.failedRows,
            })}
          </p>
        ) : null}
      </div>
      <h3 className="text-sm font-medium text-content">{t('operations.imports.problems')}</h3>
      {data.errors.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.imports.noProblems')}</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-md border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-muted text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.imports.row')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.imports.column')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.imports.problem')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.errors.map((error, index) => (
                <tr key={`${String(error.row)}-${error.column ?? ''}-${String(index)}`}>
                  <td className="px-3 py-2 font-mono text-content">{error.row}</td>
                  <td className="px-3 py-2 font-mono text-content">{error.column ?? '—'}</td>
                  <td className="px-3 py-2 text-content">{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
