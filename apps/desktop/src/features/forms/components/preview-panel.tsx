import { ApiRequestError } from '@integr8/api-client';
import {
  type CompiledForm,
  createFormState,
  findField,
  type FormEvent,
  type FormState,
  toSubmission,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useMemo, useState } from 'react';
import { Button } from '~/components/ui';
import { type TestSubmission, testSubmission } from '../api';
import { say } from '../model/text';
import { ErrorText, FormRenderer } from './form-renderer';

/**
 * Two viewports side by side, filled in together, and a test fill checked by
 * the server.
 *
 * Both viewports share one set of answers, so typing on the "desktop" shows
 * the phone reacting at the same moment — which is the fastest way to see that
 * a condition works. The server check runs the real submission validation on
 * the saved draft and stores nothing.
 */
export function PreviewPanel({
  form,
  formId,
  locale,
  canTest,
  flush,
}: {
  form: CompiledForm;
  formId: string;
  locale: string;
  /** Test fill checks the server's copy of the draft, so there must be one. */
  canTest: boolean;
  flush: () => Promise<number | null>;
}) {
  const { t } = useTranslation();
  const [today, setToday] = useState(() => localDate(new Date()));
  const [state, setState] = useState<FormState>(() => createFormState(form));
  const [result, setResult] = useState<TestSubmission | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const context = useMemo(() => ({ today }), [today]);
  const view = useMemo(() => viewForm(form, state, context), [form, state, context]);

  const onEvent = (event: FormEvent) => {
    setState((current) => transition(form, current, event, context).state);
    setResult(undefined);
  };

  const check = async () => {
    setChecking(true);
    setFailure(undefined);
    setResult(undefined);
    onEvent({ type: 'submit' });
    try {
      await flush();
      setResult(await testSubmission(formId, toSubmission(form, state, context), today));
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError
          ? t('errors.body', { requestId: error.requestId })
          : t('errors.unexpected'),
      );
    } finally {
      setChecking(false);
    }
  };

  const fieldName = (id: string | null) => {
    const field = id === null ? undefined : findField(form.definition, id);
    return field === undefined ? (id ?? '') : say(field.label, locale);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <section className="flex flex-wrap items-end gap-4 rounded-lg border border-border-subtle bg-surface p-4 text-start">
        <div className="flex max-w-prose flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold text-content">{t('forms.preview.testTitle')}</h2>
          <p className="text-sm text-content-muted">{t('forms.preview.testHint')}</p>
        </div>
        <label className="flex flex-col gap-1 text-sm text-content">
          {t('forms.preview.today')}
          <input
            type="date"
            value={today}
            onChange={(event) => event.target.value !== '' && setToday(event.target.value)}
            className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <Button
          variant="secondary"
          onClick={() => {
            setState(createFormState(form));
            setResult(undefined);
          }}
        >
          {t('forms.preview.reset')}
        </Button>
        <Button busy={checking} disabled={!canTest} onClick={() => void check()}>
          {t('forms.preview.check')}
        </Button>
      </section>

      {canTest ? null : <p className="text-sm text-content-muted">{t('forms.changes.noDraft')}</p>}

      {failure === undefined ? null : (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle px-4 py-3 text-sm"
        >
          {failure}
        </p>
      )}

      {result === undefined ? null : (
        <div
          role="status"
          className={[
            'rounded-md border px-4 py-3 text-start text-sm text-content',
            result.valid ? 'border-success bg-success-subtle' : 'border-danger bg-danger-subtle',
          ].join(' ')}
        >
          {result.valid ? (
            <p>{t('forms.preview.accepted')}</p>
          ) : (
            <>
              <p className="font-medium">{t('forms.preview.rejected')}</p>
              <ul className="mt-2 list-disc ps-5">
                {result.issues.map((issue) => (
                  <li key={`${issue.code}-${issue.field ?? ''}`}>
                    {t(`forms.preview.issue.${issue.code as 'unknown_field'}`, {
                      field: fieldName(issue.field),
                    })}
                  </li>
                ))}
                {result.errors.map((error) => {
                  const field = findField(form.definition, error.field);
                  return (
                    <li key={`${error.field}-${error.code}-${error.params.rule ?? ''}`}>
                      <span className="font-medium">{fieldName(error.field)}</span>
                      {': '}
                      {field === undefined ? (
                        error.code
                      ) : (
                        <ErrorText
                          field={field}
                          error={{ ...error, code: error.code as 'invalid' }}
                          locale={locale}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_24.5rem] items-start gap-6">
        <Viewport label={t('forms.preview.desktop')}>
          <div className="rounded-lg border border-border-subtle bg-background p-6">
            <FormRenderer
              form={form}
              state={state}
              view={view}
              onEvent={onEvent}
              viewport="desktop"
              locale={locale}
            />
          </div>
        </Viewport>
        <Viewport label={t('forms.preview.phone')}>
          <div className="mx-auto w-[24.5rem] max-w-full rounded-[2rem] border-8 border-content/80 bg-background">
            <div className="h-[44rem] overflow-y-auto rounded-[1.5rem] p-4">
              <FormRenderer
                form={form}
                state={state}
                view={view}
                onEvent={onEvent}
                viewport="phone"
                locale={locale}
              />
            </div>
          </div>
        </Viewport>
      </div>
    </div>
  );
}

function Viewport({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-content-muted">{label}</h3>
      {children}
    </section>
  );
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}
