import {
  type CompiledForm,
  compileDefinition,
  withRequiredSchemaVersion,
} from '@integr8/form-engine';
import { FormFiller } from '@integr8/form-renderer-dom';
import { directionFor, LOCALE_DESCRIPTORS, useTranslation } from '@integr8/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ChangeRequestRow,
  RequestError,
  type Tab,
  type WindowApi,
  type WindowState,
} from './api.js';

/**
 * The preview window (P37): the form in the product's own filler, each PDF
 * template as the server prints it, and the check report, refreshed by the
 * program's event stream whenever the AI changes something. The person can
 * type answers, leave notes for the AI and save the file; nothing they do
 * leaves the computer.
 *
 * The frame wears the Integr8 Media look like the other staff tools; the
 * form itself follows the light or dark theme chosen in the header, as a
 * company's workspace would show it.
 */

const button = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
};
const field =
  'w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start text-sm text-content';
const panel = 'rounded-lg border border-border-subtle bg-surface p-4';

type Connection = 'connecting' | 'live' | 'disconnected';
type Language = 'en' | 'ar';

export interface AppProps {
  api: WindowApi;
  /**
   * The form with nothing typed and nothing sent back (`?blank=1`): how a
   * change request pictures the Form tab, so no answer a person typed can end
   * up in a request (P39).
   */
  blank?: boolean;
}

function compiled(definition: unknown): CompiledForm | undefined {
  if (definition === null || definition === undefined) {
    return undefined;
  }
  const result = compileDefinition(withRequiredSchemaVersion(definition));
  return result.ok ? result.form : undefined;
}

function text(value: unknown, language: Language): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const texts = value as Record<string, unknown>;
  const chosen = texts[language] ?? texts.en ?? texts.ar;
  return typeof chosen === 'string' ? chosen : '';
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <span className="text-xs text-content-muted">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => {
            onChange(option.value);
          }}
          className={`rounded-md px-2 py-1 text-xs ${value === option.value ? 'bg-accent text-on-accent' : 'text-content hover:bg-surface-muted'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function App({ api, blank = false }: AppProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<WindowState>();
  const [failure, setFailure] = useState<string>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [tab, setTab] = useState<Tab>('form');
  const [language, setLanguage] = useState<Language>('en');
  const [width, setWidth] = useState<'phone' | 'desktop'>('desktop');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [refreshed, setRefreshed] = useState(false);
  // Answers typed here may not be in `state` yet; the PDF tab should still use them.
  const [typed, setTyped] = useState(false);
  const seenVersion = useRef<number>(undefined);
  const restored = useRef(false);

  const load = useCallback(() => {
    api.state().then(
      (next) => {
        setFailure(undefined);
        if (!restored.current && !blank) {
          // A reloaded page comes back to the view the person had.
          restored.current = true;
          setTab(next.view.tab);
          setLanguage(next.view.language);
          setWidth(next.view.width);
          setTheme(next.view.theme);
        }
        if (seenVersion.current !== undefined && next.version !== seenVersion.current) {
          setRefreshed(true);
        }
        seenVersion.current = next.version;
        setState(next);
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      },
    );
  }, [api, blank]);

  useEffect(() => {
    load();
    return api.events({
      onOpen: () => {
        setConnection('live');
        load();
      },
      onError: () => {
        setConnection('disconnected');
      },
      onState: load,
      onPdf: load,
    });
  }, [api, load]);

  useEffect(() => {
    if (!refreshed) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setRefreshed(false);
    }, 6000);
    return () => {
      clearTimeout(timer);
    };
  }, [refreshed]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dir = directionFor(language);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    void i18n.changeLanguage(language);
  }, [i18n, language, theme]);

  useEffect(() => {
    if (!restored.current) {
      return;
    }
    api.post('/view', { tab, language, width, theme }).catch(() => undefined);
  }, [api, tab, language, width, theme]);

  const form = useMemo(() => compiled(state?.definition), [state?.definition]);
  const title = text((state?.definition as { title?: unknown } | null)?.title, language);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'form', label: t('formsAiWindow.tabs.form') },
    { id: 'pdf', label: t('formsAiWindow.tabs.pdf') },
    { id: 'checks', label: t('formsAiWindow.tabs.checks') },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background text-content">
      <header data-look="integr8" className="border-b border-border-subtle px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-content-muted">{t('formsAiWindow.title')}</p>
            <h1 className="truncate text-lg font-semibold">
              {title === '' ? t('formsAiWindow.untitled') : title}
            </h1>
          </div>
          <div
            role="group"
            aria-label={t('formsAiWindow.controls.label')}
            className="flex flex-wrap items-center gap-4"
          >
            <Segmented
              label={t('formsAiWindow.controls.language')}
              value={language}
              options={LOCALE_DESCRIPTORS.map((locale) => ({
                value: locale.code,
                label: locale.nativeName,
              }))}
              onChange={setLanguage}
            />
            <Segmented
              label={t('formsAiWindow.controls.width')}
              value={width}
              options={[
                { value: 'phone', label: t('formsAiWindow.controls.phone') },
                { value: 'desktop', label: t('formsAiWindow.controls.desktop') },
              ]}
              onChange={setWidth}
            />
            <Segmented
              label={t('formsAiWindow.controls.theme')}
              value={theme}
              options={[
                { value: 'light', label: t('formsAiWindow.controls.light') },
                { value: 'dark', label: t('formsAiWindow.controls.dark') },
              ]}
              onChange={setTheme}
            />
          </div>
          <p
            role="status"
            className={`rounded-full px-3 py-1 text-xs font-medium ${connection === 'live' ? 'bg-accent-subtle text-accent' : connection === 'disconnected' ? 'bg-danger-subtle text-danger' : 'text-content-muted'}`}
          >
            {connection === 'live'
              ? t('formsAiWindow.live')
              : connection === 'disconnected'
                ? t('formsAiWindow.disconnected')
                : t('formsAiWindow.connecting')}
          </p>
        </div>
        <div
          role="tablist"
          aria-label={t('formsAiWindow.tabs.label')}
          className="mx-auto mt-3 flex max-w-6xl gap-1"
        >
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls="view"
              onClick={() => {
                setTab(entry.id);
              }}
              className={`rounded-t-md px-4 py-2 text-sm font-medium ${tab === entry.id ? 'bg-accent text-on-accent' : 'text-content hover:bg-surface-muted'}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 px-4 py-6">
        <div className="mx-auto max-w-6xl space-y-4">
          {refreshed ? (
            <p role="status" className="rounded-md bg-accent-subtle px-3 py-2 text-sm">
              {t('formsAiWindow.refreshed')}
            </p>
          ) : null}
          {failure === undefined ? null : (
            <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
              {t('formsAiWindow.failedToLoad', { message: failure })}
            </p>
          )}
          {state?.hasContent !== true ? (
            <p className="text-content-muted">{t('formsAiWindow.waiting')}</p>
          ) : (
            <section id="view" role="tabpanel" aria-labelledby={`tab-${tab}`}>
              {tab === 'form' ? (
                <FormTab
                  api={api}
                  blank={blank}
                  state={state}
                  form={form}
                  language={language}
                  width={width}
                  onTyped={() => {
                    setTyped(true);
                  }}
                />
              ) : tab === 'pdf' ? (
                <PdfTab api={api} state={state} language={language} typed={typed} />
              ) : (
                <ChecksTab api={api} state={state} />
              )}
              {blank ? null : (
                <div className="mt-6">
                  <NoteBox api={api} state={state} tab={tab} form={form} language={language} />
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      {state?.hasContent === true && !blank ? (
        <footer className="border-t border-border-subtle px-4 py-3">
          <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-4">
            <SaveBox api={api} state={state} />
            <SuggestBox api={api} tab={tab} />
          </div>
        </footer>
      ) : null}
    </div>
  );
}

function FormTab({
  api,
  state,
  form,
  language,
  width,
  onTyped,
  blank,
}: {
  api: WindowApi;
  blank: boolean;
  state: WindowState;
  form: CompiledForm | undefined;
  language: Language;
  width: 'phone' | 'desktop';
  onTyped: () => void;
}) {
  const { t } = useTranslation();
  const [submitted, setSubmitted] = useState<Record<string, unknown>>();
  const [round, setRound] = useState(0);
  const pending = useRef<Record<string, unknown>>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const answers = pending.current;
    pending.current = undefined;
    if (answers !== undefined) {
      api.post('/answers', { answers }).catch(() => undefined);
    }
  }, [api]);

  // What is typed reaches the program shortly after, and at once when the view goes.
  useEffect(() => flush, [flush]);

  if (form === undefined) {
    return (
      <div className={panel}>
        <p className="font-medium">{t('formsAiWindow.form.cannotShow')}</p>
        <ul className="mt-2 list-disc space-y-1 ps-6 text-sm">
          {(state.check?.problems ?? []).map((problem, index) => (
            <li key={index}>
              <code className="text-xs">{problem.path}</code> {problem.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={`mx-auto ${width === 'phone' ? 'max-w-[390px]' : 'max-w-4xl'}`}>
      {submitted === undefined ? (
        <FormFiller
          // A new version of the form starts the filler again, with the answers kept.
          key={`${String(state.version)}-${String(round)}`}
          form={form}
          initialAnswers={blank ? {} : state.answers}
          locale={language}
          media={api.media}
          onAnswersChange={(answers) => {
            if (blank) {
              return;
            }
            onTyped();
            pending.current = answers;
            clearTimeout(timer.current);
            timer.current = setTimeout(flush, 400);
          }}
          onSubmit={async (answers) => {
            flush();
            await api.post('/submit', { answers });
            setSubmitted(answers);
            return { ok: true };
          }}
        />
      ) : (
        <div className={panel}>
          <p role="status" className="font-medium">
            {t('formsAiWindow.form.submitted')}
          </p>
          <pre className="mt-3 max-h-[60vh] overflow-auto rounded-md bg-surface-muted p-3 text-xs">
            {JSON.stringify(submitted, null, 2)}
          </pre>
          <button
            type="button"
            className={`${button.secondary} mt-3`}
            onClick={() => {
              setSubmitted(undefined);
              setRound((value) => value + 1);
            }}
          >
            {t('formsAiWindow.form.fillAgain')}
          </button>
        </div>
      )}
    </div>
  );
}

function PdfTab({
  api,
  state,
  language,
  typed,
}: {
  api: WindowApi;
  state: WindowState;
  language: Language;
  typed: boolean;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const [useAnswers, setUseAnswers] = useState(
    () => typed || Object.keys(state.answers).length > 0,
  );
  const [printLanguage, setPrintLanguage] = useState<'' | Language>('');
  const [colour, setColour] = useState('#2563eb');
  const asked = useRef(new Set<string>());
  const index = Math.min(selected, Math.max(state.templates.length - 1, 0));
  const template = state.templates[index];
  const print = state.prints[String(index)];

  const request = useCallback(() => {
    api
      .post('/print', {
        template: index,
        useAnswers,
        companyColour: colour,
        ...(printLanguage === '' ? {} : { language: printLanguage }),
      })
      .catch(() => undefined);
  }, [api, index, useAnswers, colour, printLanguage]);

  // Printed when the tab opens or the template changed; never on every keystroke.
  useEffect(() => {
    if (template === undefined) {
      return;
    }
    const key = `${String(state.version)}:${String(index)}`;
    const current = print?.version === state.version;
    if (!current && !asked.current.has(key)) {
      asked.current.add(key);
      request();
    }
  }, [template, state.version, index, print, request]);

  if (template === undefined) {
    return <p className="text-content-muted">{t('formsAiWindow.pdf.none')}</p>;
  }

  const time = print === undefined ? '' : new Date(print.at).toLocaleTimeString(language);

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="space-y-4">
        <nav aria-label={t('formsAiWindow.pdf.templates')} className={panel}>
          <p className="mb-2 text-sm font-medium">{t('formsAiWindow.pdf.templates')}</p>
          <ul className="space-y-1">
            {state.templates.map((entry, position) => (
              <li key={position}>
                <button
                  type="button"
                  aria-current={position === index ? 'true' : undefined}
                  onClick={() => {
                    setSelected(position);
                  }}
                  className={`w-full rounded-md px-3 py-1.5 text-start text-sm ${position === index ? 'bg-accent-subtle font-medium' : 'hover:bg-surface-muted'}`}
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={`${panel} space-y-3 text-sm`}>
          <fieldset>
            <legend className="mb-1 font-medium">{t('formsAiWindow.pdf.answers')}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="answers"
                checked={useAnswers}
                onChange={() => {
                  setUseAnswers(true);
                }}
              />
              {t('formsAiWindow.pdf.myAnswers')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="answers"
                checked={!useAnswers}
                onChange={() => {
                  setUseAnswers(false);
                }}
              />
              {t('formsAiWindow.pdf.sampleAnswers')}
            </label>
          </fieldset>
          <label className="block">
            <span className="mb-1 block font-medium">{t('formsAiWindow.pdf.language')}</span>
            <select
              className={field}
              value={printLanguage}
              onChange={(event) => {
                setPrintLanguage(event.target.value as '' | Language);
              }}
            >
              <option value="">{t('formsAiWindow.pdf.templateLanguage')}</option>
              <option value="en">{t('formsAiWindow.pdf.english')}</option>
              <option value="ar">{t('formsAiWindow.pdf.arabic')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="color"
              value={colour}
              onChange={(event) => {
                setColour(event.target.value);
              }}
            />
            <span>{t('formsAiWindow.pdf.colour')}</span>
          </label>
          <button
            type="button"
            className={button.primary}
            disabled={!state.printing.available}
            onClick={request}
          >
            {t('formsAiWindow.pdf.printAgain')}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {!state.printing.available || print?.status === 'unavailable' ? (
          <p role="alert" className={`${panel} text-sm`}>
            {t('formsAiWindow.pdf.unavailable', {
              reason: print?.message ?? '',
            })}
          </p>
        ) : print === undefined ? (
          <p className="text-sm text-content-muted">{t('formsAiWindow.pdf.notPrinted')}</p>
        ) : print.status === 'waiting' || print.status === 'printing' ? (
          <p role="status" className="text-sm text-content-muted">
            {print.status === 'waiting'
              ? t('formsAiWindow.pdf.waiting')
              : t('formsAiWindow.pdf.printing')}
          </p>
        ) : print.status === 'failed' ? (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            {t('formsAiWindow.pdf.failed', { reason: print.message ?? '' })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-content-muted">
              <span>
                {print.by === 'ai'
                  ? t('formsAiWindow.pdf.printedByAi', { time })
                  : t('formsAiWindow.pdf.printedAt', { time })}
              </span>
              {print.version === state.version ? null : (
                <span className="text-warning">{t('formsAiWindow.pdf.outOfDate')}</span>
              )}
              <a
                className="text-accent underline"
                href={api.href(`/pdf/${String(index)}?v=${encodeURIComponent(print.at)}`)}
                target="_blank"
                rel="noreferrer"
              >
                {t('formsAiWindow.pdf.open')}
              </a>
            </div>
            <iframe
              title={t('formsAiWindow.pdf.frameTitle', { name: template.name })}
              src={api.href(`/pdf/${String(index)}?v=${encodeURIComponent(print.at)}`)}
              className="h-[80vh] w-full rounded-md border border-border-subtle bg-surface"
            />
          </>
        )}
      </div>
    </div>
  );
}

function ChecksTab({ api, state }: { api: WindowApi; state: WindowState }) {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<ChangeRequestRow[]>();
  useEffect(() => {
    api.requests().then(setRequests, () => {
      setRequests([]);
    });
  }, [api, state.version]);
  const statusLabel = {
    open: t('formsAiWindow.requests.open'),
    merged: t('formsAiWindow.requests.merged'),
    dropped: t('formsAiWindow.requests.dropped'),
    handed_over: t('formsAiWindow.requests.handedOver'),
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className={`${panel} lg:col-span-2`} aria-labelledby="change-requests">
        <h2 id="change-requests" className="font-medium">
          {t('formsAiWindow.requests.title')}
        </h2>
        <p className="text-sm text-content-muted">{t('formsAiWindow.requests.hint')}</p>
        {requests === undefined ? null : requests.length === 0 ? (
          <p className="mt-2 text-sm">{t('formsAiWindow.requests.none')}</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {requests.map((request) => (
              <li key={request.number}>
                <span dir="ltr" className="font-mono text-xs">
                  CR-{String(request.number).padStart(4, '0')}
                </span>{' '}
                {request.title} — {statusLabel[request.status]} ({request.date})
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={panel} aria-labelledby="check-report">
        <h2 id="check-report" className="font-medium">
          {t('formsAiWindow.checks.report')}
        </h2>
        <p className="text-sm text-content-muted">{t('formsAiWindow.checks.reportHint')}</p>
        <pre dir="ltr" className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs">
          {state.checkText}
        </pre>
      </section>
      <section className={panel} aria-labelledby="check-questions">
        <h2 id="check-questions" className="font-medium">
          {t('formsAiWindow.checks.questions')}
        </h2>
        <p className="text-sm text-content-muted">{t('formsAiWindow.checks.questionsHint')}</p>
        <pre dir="ltr" className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs">
          {state.summary}
        </pre>
      </section>
    </div>
  );
}

function NoteBox({
  api,
  state,
  tab,
  form,
  language,
}: {
  api: WindowApi;
  state: WindowState;
  tab: Tab;
  form: CompiledForm | undefined;
  language: Language;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [about, setAbout] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  const subjects =
    tab === 'pdf'
      ? state.templates.map((template) => ({ value: template.name, label: template.name }))
      : (form?.fields ?? []).map((question) => ({
          value: question.id,
          label: `${text(question.label, language)} (${question.id})`,
        }));

  return (
    <form
      className={`${panel} space-y-2`}
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim() === '') {
          return;
        }
        api.post('/note', { tab, about, text: note }).then(
          () => {
            setNote('');
            setSent(true);
            setError(undefined);
          },
          (failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure));
          },
        );
      }}
    >
      <div>
        <label htmlFor="note" className="block font-medium">
          {t('formsAiWindow.notes.label')}
        </label>
        <p id="note-hint" className="text-sm text-content-muted">
          {t('formsAiWindow.notes.hint')}
        </p>
        <textarea
          id="note"
          aria-describedby="note-hint"
          className={`${field} mt-2`}
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setSent(false);
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {subjects.length === 0 ? null : (
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1 block">{t('formsAiWindow.notes.about')}</span>
            <select
              className={field}
              value={about}
              onChange={(event) => {
                setAbout(event.target.value);
              }}
            >
              <option value="">{t('formsAiWindow.notes.aboutView')}</option>
              {subjects.map((subject) => (
                <option key={subject.value} value={subject.value}>
                  {subject.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={button.primary} disabled={note.trim() === ''}>
          {t('formsAiWindow.notes.send')}
        </button>
      </div>
      {sent ? (
        <p role="status" className="text-sm text-success">
          {t('formsAiWindow.notes.sent')}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function SuggestBox({ api, tab }: { api: WindowApi; tab: Tab }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={button.secondary}
          onClick={() => {
            setOpen(true);
            setSent(false);
          }}
        >
          {t('formsAiWindow.suggest.button')}
        </button>
        {sent ? (
          <p role="status" className="text-sm text-success">
            {t('formsAiWindow.suggest.sent')}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className={`${panel} min-w-72 flex-1 space-y-2`}
      onSubmit={(event) => {
        event.preventDefault();
        if (words.trim() === '') {
          return;
        }
        api.post('/note', { tab, text: words, platform: true }).then(
          () => {
            setWords('');
            setSent(true);
            setOpen(false);
            setError(undefined);
          },
          (failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure));
          },
        );
      }}
    >
      <label htmlFor="suggestion" className="block font-medium">
        {t('formsAiWindow.suggest.title')}
      </label>
      <p id="suggestion-hint" className="text-sm text-content-muted">
        {t('formsAiWindow.suggest.hint')}
      </p>
      <textarea
        id="suggestion"
        aria-describedby="suggestion-hint"
        className={field}
        rows={3}
        maxLength={2000}
        value={words}
        onChange={(event) => {
          setWords(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={button.primary} disabled={words.trim() === ''}>
          {t('formsAiWindow.suggest.send')}
        </button>
        <button
          type="button"
          className={button.secondary}
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('formsAiWindow.suggest.cancel')}
        </button>
      </div>
    </form>
  );
}

type SaveStep =
  | { kind: 'closed' }
  | { kind: 'asking' }
  | { kind: 'exists'; path: string }
  | { kind: 'saved'; path: string; ok: boolean }
  | { kind: 'failed'; reason: string };

function SaveBox({ api, state }: { api: WindowApi; state: WindowState }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<SaveStep>({ kind: 'closed' });
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);

  const save = (overwrite: boolean) => {
    setBusy(true);
    api
      .post('/save', { fileName, overwrite })
      .then(
        (result) => {
          setStep({ kind: 'saved', path: String(result.path), ok: result.ok === true });
        },
        (error: unknown) => {
          if (error instanceof RequestError && error.body.exists === true) {
            setStep({ kind: 'exists', path: String(error.body.path) });
          } else {
            setStep({
              kind: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  if (step.kind === 'closed') {
    return (
      <button
        type="button"
        className={button.primary}
        onClick={() => {
          setStep({ kind: 'asking' });
        }}
      >
        {t('formsAiWindow.save.button')}
      </button>
    );
  }

  return (
    <div className={`${panel} space-y-3`}>
      <h2 className="font-medium">{t('formsAiWindow.save.title')}</h2>
      {step.kind === 'saved' ? (
        <p role="status" className="text-sm">
          {step.ok
            ? t('formsAiWindow.save.saved', { path: step.path })
            : t('formsAiWindow.save.savedNotOk', { path: step.path })}
        </p>
      ) : step.kind === 'exists' ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {t('formsAiWindow.save.exists', { path: step.path })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={button.primary}
              disabled={busy}
              onClick={() => {
                save(true);
              }}
            >
              {t('formsAiWindow.save.replace')}
            </button>
            <button
              type="button"
              className={button.secondary}
              onClick={() => {
                setStep({ kind: 'asking' });
              }}
            >
              {t('formsAiWindow.save.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save(false);
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('formsAiWindow.save.fileName')}</span>
            <input
              className={field}
              value={fileName}
              maxLength={120}
              onChange={(event) => {
                setFileName(event.target.value);
              }}
            />
            <span className="mt-1 block text-content-muted">
              {t('formsAiWindow.save.fileNameHint')}
            </span>
          </label>
          <p className="text-sm text-content-muted">
            {t('formsAiWindow.save.folder', { folder: state.outputFolder })}
          </p>
          {step.kind === 'failed' ? (
            <p role="alert" className="text-sm text-danger">
              {t('formsAiWindow.save.failed', { reason: step.reason })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button type="submit" className={button.primary} disabled={busy}>
              {t('formsAiWindow.save.save')}
            </button>
            <button
              type="button"
              className={button.secondary}
              onClick={() => {
                setStep({ kind: 'closed' });
              }}
            >
              {t('formsAiWindow.save.cancel')}
            </button>
          </div>
        </form>
      )}
      {step.kind === 'saved' ? (
        <button
          type="button"
          className={button.secondary}
          onClick={() => {
            setStep({ kind: 'closed' });
          }}
        >
          {t('common.close')}
        </button>
      ) : null}
    </div>
  );
}
