import { ApiRequestError } from '@integr8/api-client';
import { formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  type AiAllowance,
  type AiBlockedBy,
  type AiCapabilities,
  type AiConversation,
  type AiConversationDetail,
  type AiMessage,
  type AiProposal,
  keys,
  useOperations,
} from '../api.js';
import { buttonClass, cardClass, DashboardBackLink, Failure, InlineError, Loading } from '../ui.js';
import { MessageItem } from './message-parts.js';
import { UsageMeter } from './usage-meter.js';
import {
  ReadAloudContext,
  speechLanguage,
  useReadAloud,
  useSpeechInput,
  type ReadAloud,
} from './voice.js';

/**
 * The Integr8 Plus assistant (docs/ai §10.1; ADR-0001).
 *
 * The screen asks `/v1/ai/capabilities` first and believes it: at `off` it
 * explains which switch is closed and offers nothing interactive, since a
 * working composer behind a hidden menu item would be a way round the
 * company's own settings. Otherwise it is two panes — the member's private
 * conversations, and the one open — stacked on a phone.
 *
 * Every answer carries what is left of the member's share, as a percentage,
 * so the meter is updated from the answer and the capabilities are asked
 * again only after a refusal for quota, when the server knows better than the
 * screen.
 *
 * Voice (docs/ai §10.5) uses the device's own tools: a microphone button when
 * answers come from a model and the app has a recogniser, and answers read
 * aloud for every company once the person turns it on.
 */

/** What the server accepts in one message; a longer one is refused with 422. */
export const MAX_MESSAGE_CHARS = 4_000;

type Locale = 'en' | 'ar';

export function AssistantScreen() {
  const { client } = useOperations();
  const capabilities = useQuery({
    queryKey: keys.aiCapabilities,
    queryFn: async () => (await client.GET('/v1/ai/capabilities')).data!,
    staleTime: 30_000,
  });

  if (capabilities.isPending) {
    return <Loading />;
  }
  if (capabilities.isError) {
    return <Failure error={capabilities.error} onRetry={() => void capabilities.refetch()} />;
  }
  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      {capabilities.data.level === 'off' ? (
        <OffState blockedBy={capabilities.data.blockedBy} />
      ) : (
        <Assistant capabilities={capabilities.data} />
      )}
    </div>
  );
}

/** Why there is nothing here, calmly: an answer, not an error. */
function OffState({ blockedBy }: { blockedBy: AiBlockedBy | null }) {
  const { t } = useTranslation();
  return (
    <section role="status" className={cardClass}>
      <h1 className="text-2xl font-semibold text-content">{t('ai.title')}</h1>
      <p className="max-w-prose text-sm text-content">
        {blockedBy === null ? t('ai.off.generic') : t(`ai.off.${blockedBy}`)}
      </p>
    </section>
  );
}

function Assistant({ capabilities }: { capabilities: AiCapabilities }) {
  const { t, i18n } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const locale: Locale = i18n.language.startsWith('ar') ? 'ar' : 'en';
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const conversations = useQuery({
    queryKey: keys.aiConversations,
    queryFn: async () => (await client.GET('/v1/ai/conversations')).data!.items,
  });

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ai/conversations', {
          body: { locale },
          // Starting a conversation is a write; the key keeps a retried start from making two.
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        })
      ).data!,
    onSuccess: async (created) => {
      queries.setQueryData<AiConversation[]>(keys.aiConversations, (old) => [
        created,
        ...(old ?? []),
      ]);
      queries.setQueryData<AiConversationDetail>(keys.aiConversation(created.id), {
        conversation: created,
        messages: [],
      });
      setSelectedId(created.id);
      await queries.invalidateQueries({ queryKey: keys.aiConversations });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await client.DELETE('/v1/ai/conversations/{conversationId}', {
        params: { path: { conversationId: id } },
      });
      return id;
    },
    onSuccess: async (id) => {
      if (selectedId === id) {
        setSelectedId(null);
      }
      queries.removeQueries({ queryKey: keys.aiConversation(id) });
      await queries.invalidateQueries({ queryKey: keys.aiConversations });
    },
  });

  const level = capabilities.level === 'off' ? 'help' : capabilities.level;
  const readAloud = useReadAloud({ lang: speechLanguage(locale) });

  return (
    <ReadAloudContext.Provider value={readAloud}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-content">{t('ai.title')}</h1>
          <span className="inline-flex items-center rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-content">
            {t(`ai.level.${level}`)}
          </span>
          {readAloud.supported ? <ReadAloudControls readAloud={readAloud} /> : null}
        </div>
        <p className="max-w-prose text-sm text-content-muted">
          {capabilities.answerSource === 'library'
            ? t('ai.level.hint.library')
            : t(`ai.level.hint.${level}`)}
        </p>
        {level !== 'help' && !capabilities.companyDataToProvider ? (
          <p className="max-w-prose text-sm text-content-muted">{t('ai.level.noCompanyData')}</p>
        ) : null}
        <UsageMeter allowance={capabilities.usage.allowance} />
        {readAloud.hintShown ? <ReadAloudHint readAloud={readAloud} /> : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3" aria-label={t('ai.conversations.title')}>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('ai.conversations.new')}
          </button>
          {create.isError ? <Failure error={create.error} /> : null}
          {remove.isError ? <Failure error={remove.error} /> : null}
          {conversations.isPending ? (
            <Loading />
          ) : conversations.isError ? (
            <InlineError onRetry={() => void conversations.refetch()} />
          ) : conversations.data.length === 0 ? (
            <p className="text-sm text-content-muted">{t('ai.conversations.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {conversations.data.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  selected={conversation.id === selectedId}
                  busy={remove.isPending}
                  onOpen={() => setSelectedId(conversation.id)}
                  onDelete={() => {
                    if (window.confirm(t('ai.conversations.deleteConfirm'))) {
                      remove.mutate(conversation.id);
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </aside>

        {selectedId === null ? (
          <section className={`${cardClass} min-h-64 justify-center text-center`}>
            <p className="text-sm text-content-muted">{t('ai.conversations.pick')}</p>
          </section>
        ) : (
          <Thread
            key={selectedId}
            conversationId={selectedId}
            locale={locale}
            allowance={capabilities.usage.allowance}
            spokenQuestions={capabilities.answerSource === 'model'}
          />
        )}
      </div>
    </ReadAloudContext.Provider>
  );
}

/**
 * Whether answers are read aloud, as a switch in the header, and a way to stop
 * the one being read. Off until the person turns it on; the choice stays on
 * this device.
 */
function ReadAloudControls({ readAloud }: { readAloud: ReadAloud }) {
  const { t } = useTranslation();
  return (
    <span className="ms-auto inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={buttonClass.secondary}
        aria-pressed={readAloud.enabled}
        onClick={() => readAloud.setEnabled(!readAloud.enabled)}
      >
        <SpeakerIcon muted={!readAloud.enabled} />
        {t('ai.voice.readAloud')}
        <span className="text-xs text-content-muted">
          {readAloud.enabled ? t('ai.voice.on') : t('ai.voice.off')}
        </span>
      </button>
      {readAloud.speakingId === null ? null : (
        <button type="button" className={buttonClass.ghost} onClick={() => readAloud.stop()}>
          {t('ai.voice.stopReading')}
        </button>
      )}
    </span>
  );
}

/** The first visit's pointer to the switch above: answers can be read aloud. */
function ReadAloudHint({ readAloud }: { readAloud: ReadAloud }) {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-accent bg-surface-muted px-4 py-3 text-sm text-content"
    >
      <SpeakerIcon muted={false} />
      <span className="flex-1">{t('ai.voice.hint')}</span>
      <button
        type="button"
        className={buttonClass.primary}
        onClick={() => readAloud.setEnabled(true)}
      >
        {t('ai.voice.turnOn')}
      </button>
      <button type="button" className={buttonClass.ghost} onClick={() => readAloud.dismissHint()}>
        {t('ai.voice.dismiss')}
      </button>
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 shrink-0 rtl:-scale-x-100"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 5 6 9H3v6h3l5 4z" />
      {muted ? (
        <path d="m22 9-6 6m0-6 6 6" />
      ) : (
        <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
      )}
    </svg>
  );
}

function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}

function ConversationRow({
  conversation,
  selected,
  busy,
  onOpen,
  onDelete,
}: {
  conversation: AiConversation;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const title = conversation.title ?? t('ai.conversations.untitled');
  return (
    <li
      className={`flex items-center gap-1 rounded-md border ${
        selected ? 'border-accent bg-surface' : 'border-transparent'
      }`}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-start hover:bg-surface-muted"
        onClick={onOpen}
      >
        <span className="w-full truncate text-sm font-medium text-content" dir="auto">
          {title}
        </span>
        <span className="text-xs text-content-muted">
          {formatDateTime(conversation.updatedAt, { locale })}
        </span>
      </button>
      <button
        type="button"
        className={buttonClass.ghost}
        aria-label={t('ai.conversations.deleteLabel', { title })}
        disabled={busy}
        onClick={onDelete}
      >
        ✕
      </button>
    </li>
  );
}

/** The text the person typed, kept until the server has answered it. */
interface Attempt {
  key: string;
  text: string;
}

/**
 * The quota-refusal's own reset time, when the refusal names one. Every
 * refusal for an allowance names it — messages or tokens, the company's or
 * the member's, day or month, and the member's dollar cap
 * (`ai_member_budget_exceeded`), whose amount is never said — so they all
 * close the composer the same way.
 */
function resetFromRefusal(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 429) {
    return null;
  }
  const detail = error.details.find((entry) => entry.params?.resetsAt !== undefined);
  return detail?.params?.resetsAt ?? null;
}

function Thread({
  conversationId,
  locale,
  allowance,
  spokenQuestions,
}: {
  conversationId: string;
  locale: Locale;
  allowance: AiAllowance;
  /** Whether a question may be spoken here: only when a model answers (docs/ai §10.5). */
  spokenQuestions: boolean;
}) {
  const { t } = useTranslation();
  const { client, locale: displayLocale, voiceInput = { kind: 'browser' } } = useOperations();
  const queries = useQueryClient();
  const readAloud = useContext(ReadAloudContext);
  const [draft, setDraft] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** What was in the box when listening began; the spoken words follow it. */
  const typedBeforeSpeaking = useRef('');
  const [dictationHint, setDictationHint] = useState(false);
  const speech = useSpeechInput({
    lang: speechLanguage(locale),
    enabled: spokenQuestions && voiceInput.kind === 'browser',
    onTranscript: (text) => {
      const before = typedBeforeSpeaking.current;
      setDraft(before === '' || text === '' ? `${before}${text}` : `${before} ${text}`);
    },
  });

  const detail = useQuery({
    queryKey: keys.aiConversation(conversationId),
    queryFn: async () =>
      (
        await client.GET('/v1/ai/conversations/{conversationId}', {
          params: { path: { conversationId } },
        })
      ).data!,
  });

  const send = useMutation({
    mutationFn: async ({ key, text }: Attempt) =>
      (
        await client.POST('/v1/ai/conversations/{conversationId}/messages', {
          params: { path: { conversationId }, header: { 'Idempotency-Key': key } },
          body: { message: text, locale },
        })
      ).data!,
    onSuccess: async (answer, { key, text }) => {
      // The answer carries the assistant's message only; the person's own is
      // what they typed, kept here until the next read brings the stored one.
      const asked: AiMessage = {
        id: key,
        role: 'user',
        text,
        sources: [],
        toolSummaries: [],
        actionProposal: null,
        createdAt: new Date().toISOString(),
      };
      queries.setQueryData<AiConversationDetail>(keys.aiConversation(conversationId), (old) =>
        old === undefined ? old : { ...old, messages: [...old.messages, asked, answer.message] },
      );
      queries.setQueryData<AiCapabilities>(keys.aiCapabilities, (old) =>
        old === undefined ? old : { ...old, usage: { ...old.usage, allowance: answer.allowance } },
      );
      setDraft('');
      setAttempt(null);
      setLockedUntil(null);
      if (readAloud?.enabled === true) {
        readAloud.speak(answer.message.id, answer.message.text);
      }
      await queries.invalidateQueries({ queryKey: keys.aiConversations });
    },
    onError: async (error) => {
      const resetsAt = resetFromRefusal(error);
      if (resetsAt !== null) {
        setLockedUntil(resetsAt);
        await queries.invalidateQueries({ queryKey: keys.aiCapabilities });
      }
    },
  });

  // A refusal for quota closes the composer until the reset it names, even
  // before the capabilities are read again; a timer opens it at that moment.
  useEffect(() => {
    if (lockedUntil === null) {
      return undefined;
    }
    const wait = Math.min(2_147_483_647, Math.max(0, new Date(lockedUntil).getTime() - Date.now()));
    const timer = setTimeout(() => setLockedUntil(null), wait);
    return () => clearTimeout(timer);
  }, [lockedUntil]);

  const locked = allowance.exhausted || lockedUntil !== null;
  const resetsAt = lockedUntil ?? (allowance.exhausted ? allowance.resetsAt : null);
  const text = draft.trim();
  const tooLong = draft.length > MAX_MESSAGE_CHARS;
  const canSend = !send.isPending && !locked && text !== '' && !tooLong;

  const submit = () => {
    if (!canSend) {
      return;
    }
    // A retry of the same words reuses its key, so a network failure after
    // the server answered is replayed rather than charged twice.
    const next: Attempt =
      attempt !== null && attempt.text === text ? attempt : { key: crypto.randomUUID(), text };
    // A new question ends the listening and the reading before it.
    speech.stop();
    readAloud?.stop();
    setAttempt(next);
    send.mutate(next);
  };

  const speak = () => {
    if (voiceInput.kind === 'dictation') {
      composer.current?.focus();
      setDictationHint(true);
      return;
    }
    if (speech.listening) {
      speech.stop();
      return;
    }
    typedBeforeSpeaking.current = draft.trimEnd();
    speech.start();
  };

  const microphone =
    spokenQuestions && (voiceInput.kind === 'dictation' || speech.supported)
      ? voiceInput.kind
      : null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const setProposal = (proposal: AiProposal) => {
    queries.setQueryData<AiConversationDetail>(keys.aiConversation(conversationId), (old) =>
      old === undefined
        ? old
        : {
            ...old,
            messages: old.messages.map((message) =>
              message.actionProposal?.id === proposal.id
                ? { ...message, actionProposal: proposal }
                : message,
            ),
          },
    );
  };

  return (
    <section className={`${cardClass} min-h-64`} aria-label={t('ai.thread.title')}>
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <ol
          aria-live="polite"
          aria-label={t('ai.thread.messages')}
          className="flex flex-1 flex-col gap-3"
        >
          {detail.data.messages.length === 0 && !send.isPending ? (
            <li className="text-sm text-content-muted">{t('ai.thread.empty')}</li>
          ) : null}
          {detail.data.messages.map((message) => (
            <MessageItem key={message.id} message={message} onProposalChange={setProposal} />
          ))}
          {send.isPending ? (
            <>
              <li className="max-w-[85%] self-end rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-on-accent opacity-80">
                <span className="sr-only">{t('ai.thread.you')}</span>
                <span dir="auto">{send.variables.text}</span>
              </li>
              <li role="status" className="self-start text-sm text-content-muted">
                {t('ai.thread.answering')}
              </li>
            </>
          ) : null}
        </ol>
      )}

      {send.isError ? <Failure error={send.error} onRetry={canSend ? submit : undefined} /> : null}

      {locked ? (
        <p role="status" className="text-sm text-danger">
          {resetsAt === null
            ? t('ai.allowance.usedUp')
            : t('ai.allowance.usedUpResets', {
                time: formatDateTime(resetsAt, { locale: displayLocale }),
              })}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor="ai-composer" className="text-sm font-medium text-content">
          {t('ai.composer.label')}
        </label>
        <textarea
          id="ai-composer"
          ref={composer}
          rows={3}
          dir="auto"
          value={draft}
          disabled={send.isPending || locked}
          aria-describedby="ai-composer-hint"
          aria-invalid={tooLong ? 'true' : undefined}
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start text-sm text-content disabled:cursor-not-allowed disabled:opacity-70 aria-[invalid=true]:border-danger"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {microphone === 'dictation' && dictationHint && voiceInput.kind === 'dictation' ? (
          <p role="status" className="text-sm text-content">
            {t(`ai.voice.dictation.${voiceInput.os}`)}
          </p>
        ) : null}
        {speech.listening ? (
          <p role="status" className="text-sm text-content">
            {t('ai.voice.listening')}
          </p>
        ) : null}
        {speech.error === null ? null : (
          <p role="alert" className="text-sm text-danger">
            {speech.error === 'blocked' ? t('ai.voice.micBlocked') : t('ai.voice.unavailable')}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id="ai-composer-hint" className="text-xs text-content-muted">
            {t('ai.composer.hint')}
          </span>
          <span
            className={`text-xs tabular-nums ${tooLong ? 'text-danger' : 'text-content-muted'}`}
          >
            {t('ai.composer.counter', {
              used: formatNumber(draft.length, { locale: displayLocale }),
              max: formatNumber(MAX_MESSAGE_CHARS, { locale: displayLocale }),
            })}
          </span>
          <span className="inline-flex items-center gap-2">
            {microphone === null ? null : (
              <button
                type="button"
                className={buttonClass.secondary}
                aria-pressed={microphone === 'browser' ? speech.listening : undefined}
                disabled={send.isPending || locked}
                onClick={speak}
              >
                <MicrophoneIcon />
                {speech.listening ? t('ai.voice.stopListening') : t('ai.voice.speak')}
              </button>
            )}
            <button type="submit" className={buttonClass.primary} disabled={!canSend}>
              {t('ai.composer.send')}
            </button>
          </span>
        </div>
      </form>
    </section>
  );
}
