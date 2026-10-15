import { apiErrorCodeMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type AiMessage, type AiProposal, type AiProposalState, useOperations } from '../api.js';
import { buttonClass, Failure } from '../ui.js';
import { appRoutePath, recordPath } from './routes.js';

/**
 * One message of a conversation, as the person reads it (docs/ai §10.1).
 *
 * A user's bubble sits at the end of the line and the assistant's at the
 * start; a tool summary is a quiet line between them. An assistant's
 * citations are chips that open the app's own page for the article, or the
 * help site in a new tab, and never show an article's key. Text is plain:
 * nothing the model wrote is ever rendered as HTML.
 */
export function MessageItem({
  message,
  onProposalChange,
}: {
  message: AiMessage;
  onProposalChange: (proposal: AiProposal) => void;
}) {
  const { t } = useTranslation();
  if (message.role === 'tool_summary') {
    return (
      <li className="self-start text-xs text-content-muted italic" dir="auto">
        {message.text}
      </li>
    );
  }
  const mine = message.role === 'user';
  return (
    <li
      className={`flex max-w-[85%] flex-col gap-2 ${mine ? 'self-end items-end' : 'self-start items-start'}`}
    >
      <span className="sr-only">{mine ? t('ai.thread.you') : t('ai.thread.assistant')}</span>
      <div
        dir="auto"
        className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          mine ? 'bg-accent text-on-accent' : 'bg-surface-muted text-content'
        }`}
      >
        {message.text}
      </div>
      {message.toolSummaries.length > 0 ? <ToolSummaries message={message} /> : null}
      {message.sources.length > 0 ? <Sources message={message} /> : null}
      {message.actionProposal === null ? null : (
        <ProposalCard proposal={message.actionProposal} onChange={onProposalChange} />
      )}
    </li>
  );
}

function Sources({ message }: { message: AiMessage }) {
  const { t } = useTranslation();
  const { paths, navigate } = useOperations();
  const chip =
    'inline-flex items-center rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-xs text-content';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-content-muted">{t('ai.thread.sources')}</span>
      <ul className="flex flex-wrap gap-1">
        {message.sources.map((source) => {
          const to = appRoutePath(paths, source.appRoute);
          return (
            <li key={`${source.articleKey}-${source.appRoute ?? ''}`}>
              {to !== undefined ? (
                <a
                  href={to}
                  className={`${chip} text-accent underline-offset-4 hover:underline`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(to);
                  }}
                >
                  {source.label}
                </a>
              ) : source.helpUrl !== null ? (
                <a
                  href={source.helpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${chip} text-accent underline-offset-4 hover:underline`}
                  title={t('ai.thread.newTab')}
                >
                  {source.label}
                </a>
              ) : (
                <span className={chip}>{source.label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolSummaries({ message }: { message: AiMessage }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 text-xs text-content-muted">
      <span className="font-medium">{t('ai.thread.lookedUp')}</span>
      <ul className="list-disc ps-4">
        {message.toolSummaries.map((summary, index) => (
          <li key={`${summary.tool}-${index}`} dir="auto">
            {summary.result}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATE_TONE: Record<AiProposalState, string> = {
  pending: 'border-warning bg-warning-subtle text-content',
  confirmed: 'border-accent bg-surface text-content',
  executing: 'border-accent bg-surface text-content',
  completed: 'border-success bg-success-subtle text-content',
  rejected: 'border-border-subtle bg-surface-muted text-content-muted',
  expired: 'border-border-subtle bg-surface-muted text-content-muted',
  failed: 'border-danger bg-danger-subtle text-content',
};

/** The time left on a proposal, ticking once a second while it is still waiting. */
function useTimeLeft(expiresAt: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

function clock(ms: number): string {
  const total = Math.ceil(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A change the assistant prepared, waiting for the person's word (docs/ai §9).
 *
 * Nothing is said to be done until the server says `completed`: the card
 * shows the server's state and only that. Confirming sends a fresh
 * Idempotency-Key, and a refusal (expired, already carried out, no longer
 * allowed) is followed by a fresh read of the proposal, so the card shows
 * where it really stands rather than where it was.
 */
export function ProposalCard({
  proposal,
  onChange,
}: {
  proposal: AiProposal;
  onChange: (proposal: AiProposal) => void;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const pending = proposal.state === 'pending';
  const timeLeft = useTimeLeft(proposal.expiresAt, pending);
  const running = proposal.state === 'confirmed' || proposal.state === 'executing';

  // While the server is still carrying it out, ask again until it is not.
  const poll = useQuery({
    queryKey: ['ai', 'action', proposal.id],
    queryFn: async () =>
      (
        await client.GET('/v1/ai/actions/{proposalId}', {
          params: { path: { proposalId: proposal.id } },
        })
      ).data!,
    enabled: running,
    refetchInterval: running ? 2_000 : false,
  });
  useEffect(() => {
    if (poll.data !== undefined && poll.data.state !== proposal.state) {
      onChange(poll.data);
    }
  }, [poll.data, proposal.state, onChange]);

  const refresh = async () => {
    try {
      const { data } = await client.GET('/v1/ai/actions/{proposalId}', {
        params: { path: { proposalId: proposal.id } },
      });
      if (data !== undefined) {
        onChange(data);
      }
    } catch {
      // The card keeps the state it had; the refusal under it says what happened.
    }
  };

  const confirm = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ai/actions/{proposalId}/confirm', {
          params: {
            path: { proposalId: proposal.id },
            header: { 'Idempotency-Key': crypto.randomUUID() },
          },
        })
      ).data!,
    onSuccess: async (updated) => {
      onChange(updated);
      if (updated.state === 'completed') {
        // The record it made or changed is shown elsewhere from these caches.
        await Promise.all(
          [['customers'], ['work-orders'], ['crm']].map((queryKey) =>
            queries.invalidateQueries({ queryKey }),
          ),
        );
      }
    },
    onError: refresh,
  });

  const reject = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ai/actions/{proposalId}/reject', {
          params: { path: { proposalId: proposal.id } },
        })
      ).data!,
    onSuccess: onChange,
    onError: refresh,
  });

  const busy = confirm.isPending || reject.isPending;
  const lapsed = pending && timeLeft === 0;
  const failure = confirm.isError ? confirm.error : reject.isError ? reject.error : undefined;
  const failedWords =
    proposal.state === 'failed' && proposal.errorCode !== null
      ? apiErrorCodeMessage(proposal.errorCode, t)
      : undefined;
  const resultPath =
    proposal.result === null
      ? undefined
      : recordPath(paths, proposal.result.appRoute, proposal.result.resourceId);

  return (
    <section
      aria-label={t('ai.proposal.title')}
      className="flex w-full flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-3 text-start text-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-content" dir="auto">
          {proposal.preview.title}
        </h3>
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_TONE[proposal.state]}`}
        >
          {proposal.state === 'executing' ? (
            <span
              aria-hidden="true"
              className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
          ) : null}
          {t(`ai.proposal.state.${proposal.state}`)}
        </span>
      </header>

      {proposal.preview.fields.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          {proposal.preview.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="text-content-muted" dir="auto">
                {field.label}
              </dt>
              <dd className="text-content" dir="auto">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {proposal.preview.warnings.length > 0 ? (
        <div className="rounded-md border border-warning bg-warning-subtle px-3 py-2">
          <p className="text-xs font-medium text-content">{t('ai.proposal.warnings')}</p>
          <ul className="list-disc ps-4 text-xs text-content">
            {proposal.preview.warnings.map((warning) => (
              <li key={warning} dir="auto">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pending ? (
        <p role="status" className="text-xs text-content-muted tabular-nums">
          {lapsed
            ? t('ai.proposal.expired')
            : t('ai.proposal.expiresIn', { time: clock(timeLeft) })}
        </p>
      ) : null}

      {running ? (
        <p role="status" className="text-xs text-content-muted">
          {t('ai.proposal.nothingYet')}
        </p>
      ) : null}

      {proposal.state === 'completed' && proposal.result !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-content">
          <span dir="auto">{proposal.result.summary}</span>
          {resultPath === undefined ? null : (
            <a
              href={resultPath}
              className="text-accent underline-offset-4 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                navigate(resultPath);
              }}
            >
              {t('ai.proposal.openRecord')}
            </a>
          )}
        </p>
      ) : null}

      {failedWords === undefined ? null : (
        <p role="alert" className="text-danger">
          {failedWords}
        </p>
      )}

      {failure === undefined ? null : <Failure error={failure} />}

      {pending ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.primary}
            disabled={busy || lapsed}
            onClick={() => confirm.mutate()}
          >
            {t('ai.proposal.confirm')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            {t('ai.proposal.reject')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
