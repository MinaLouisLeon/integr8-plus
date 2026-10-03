import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { buttonClass } from '../widgets/types.js';
import { keys, useScreens } from './api.js';
import { Failure, Loading } from './parts.js';

/**
 * Where filling starts: the forms this person may fill, and the ones they left
 * unfinished — on this device or any other, because drafts live on the server.
 */
export function FillStartScreen() {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useScreens();

  const forms = useQuery({
    queryKey: keys.forms,
    queryFn: async () => (await client.GET('/v1/forms')).data!.items,
  });
  const drafts = useQuery({
    queryKey: keys.drafts,
    queryFn: async () =>
      (await client.GET('/v1/submissions', { params: { query: { status: 'draft', limit: 50 } } }))
        .data!.items,
  });
  const start = useMutation({
    mutationFn: async (formId: string) =>
      (
        await client.POST('/v1/submissions', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { formId },
        })
      ).data!,
    onSuccess: (detail) => navigate(paths.submission(detail.submission.id)),
  });

  const fillable = forms.data?.filter((form) => form.canFill) ?? [];

  return (
    <div className="flex flex-col gap-8 text-start">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('submissions.start.title')}</h1>
        <p className="text-sm text-content-muted">{t('submissions.start.subtitle')}</p>
      </header>

      <section aria-labelledby="drafts-heading" className="flex flex-col gap-3">
        <h2 id="drafts-heading" className="text-lg font-semibold text-content">
          {t('submissions.start.drafts')}
        </h2>
        {drafts.isPending ? <Loading /> : null}
        {drafts.isError ? (
          <Failure error={drafts.error} onRetry={() => void drafts.refetch()} />
        ) : null}
        {drafts.data?.length === 0 ? (
          <p className="text-sm text-content-muted">{t('submissions.start.noDrafts')}</p>
        ) : null}
        {drafts.data === undefined || drafts.data.length === 0 ? null : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {drafts.data.map((draft) => (
              <li
                key={draft.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-content">{draft.formTitle}</span>
                  <span className="text-xs text-content-muted">
                    {t('submissions.start.lastSaved', {
                      when: formatDateTime(draft.updatedAt, { locale }),
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => navigate(paths.submission(draft.id))}
                >
                  {t('submissions.list.open')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="forms-heading" className="flex flex-col gap-3">
        <h2 id="forms-heading" className="text-lg font-semibold text-content">
          {t('forms.list.title')}
        </h2>
        {forms.isPending ? <Loading /> : null}
        {forms.isError ? (
          <Failure error={forms.error} onRetry={() => void forms.refetch()} />
        ) : null}
        {start.isError ? <Failure error={start.error} /> : null}
        {forms.data !== undefined && fillable.length === 0 ? (
          <p className="text-sm text-content-muted">{t('submissions.start.empty')}</p>
        ) : null}
        <ul className="grid gap-3 sm:grid-cols-2">
          {fillable.map((form) => (
            <li
              key={form.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3"
            >
              <span className="text-sm font-medium text-content">{form.title}</span>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={start.isPending}
                aria-busy={start.isPending && start.variables === form.id}
                onClick={() => start.mutate(form.id)}
              >
                {t('submissions.start.start')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
