import { apiErrorCodeMessage, formatPercent, useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { onlineFailureMessage } from '~/components/online';
import { Badge, Body, Button, Detail, EmptyState, useTheme } from '~/components/ui';
import { type Allowance, allowanceLine, screenForAppRoute } from '~/lib/assistant';
import { formatDuration, formatWhen } from '~/lib/format';
import { useNow } from '~/lib/use-now';
import {
  confirmAiAction,
  fetchAiAction,
  rejectAiAction,
  type AiMessage,
  type AiProposal,
} from '~/local/online';

/**
 * The assistant's conversation, piece by piece (docs/ai §10.4): a message
 * as a bubble, a citation as a chip that opens the help page or the phone's
 * own screen, and a prepared action as a card that does nothing until the
 * person confirms it — and says "done" only once the server has.
 */

/** No connection: the one state the assistant has nothing to offer in. */
export function AssistantOffline({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <EmptyState title={t('mobile.online.needed')} body={t('mobile.ai.offline')} />
      <Button label={t('mobile.online.retry')} variant="secondary" onPress={onRetry} />
    </>
  );
}

/**
 * What is left of this person's allowance, as one line: a percentage and when
 * it resets (ADR-0002 D7). Never a count or an amount — the server sends none.
 */
export function AllowanceLine({ allowance }: { allowance: Allowance }) {
  const { t, i18n } = useTranslation();
  const line = allowanceLine(allowance);
  if (line === null) {
    return null;
  }
  const when = line.resetsAt === null ? null : formatWhen(line.resetsAt, i18n.language);
  if (line.kind === 'usedUp') {
    return (
      <Body muted>
        {when === null ? t('mobile.ai.usage.usedUp') : t('mobile.ai.usage.usedUpResets', { when })}
      </Body>
    );
  }
  const percent = formatPercent(line.percent / 100, { locale: i18n.language });
  return (
    <Body muted>
      {when === null
        ? t('mobile.ai.usage.left', { percent })
        : t('mobile.ai.usage.leftResets', { percent, when })}
    </Body>
  );
}

/** One message in the thread: the person's, the assistant's, or a muted note of what a tool did. */
export function MessageBubble({
  message,
  onProposalChange,
}: {
  message: AiMessage;
  onProposalChange: (proposal: AiProposal) => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();

  if (message.role === 'tool_summary') {
    return <Text style={[styles.toolSummary, { color: theme.textMuted }]}>{message.text}</Text>;
  }
  if (message.role === 'user') {
    return (
      <View
        accessibilityLabel={t('mobile.ai.you')}
        style={[styles.bubble, styles.mine, { backgroundColor: theme.accentSubtle }]}
      >
        <Text style={[styles.text, { color: theme.text }]}>{message.text}</Text>
      </View>
    );
  }
  return (
    <View
      accessibilityLabel={t('mobile.ai.assistant')}
      style={[
        styles.bubble,
        styles.theirs,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      {message.text === '' ? null : (
        <Text style={[styles.text, { color: theme.text }]}>{message.text}</Text>
      )}
      {message.toolSummaries.map((summary, index) => (
        <Text key={index} style={[styles.toolSummary, { color: theme.textMuted }]}>
          {summary.result}
        </Text>
      ))}
      {message.sources.length === 0 ? null : (
        <View style={styles.sources}>
          <Text style={[styles.sourcesTitle, { color: theme.textMuted }]}>
            {t('mobile.ai.sources')}
          </Text>
          <View style={styles.chips}>
            {message.sources.map((source) => (
              <SourceChip
                key={source.articleKey}
                label={source.label}
                helpUrl={source.helpUrl}
                appRoute={source.appRoute}
              />
            ))}
          </View>
        </View>
      )}
      {message.actionProposal === null ? null : (
        <ProposalCard proposal={message.actionProposal} onChange={onProposalChange} />
      )}
    </View>
  );
}

/**
 * A citation. The help page when the article has one; otherwise the phone's
 * screen for what it is about, when the phone has one; otherwise just its name.
 */
function SourceChip({
  label,
  helpUrl,
  appRoute,
}: {
  label: string;
  helpUrl: string | null;
  appRoute: string | null;
}) {
  const theme = useTheme();
  const screen = screenForAppRoute(appRoute);
  const open =
    helpUrl !== null
      ? () => void WebBrowser.openBrowserAsync(helpUrl)
      : screen !== null
        ? () => router.push(screen)
        : undefined;
  if (open === undefined) {
    return <Badge label={label} tone="muted" />;
  }
  return (
    <Pressable
      accessibilityRole="link"
      onPress={open}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: theme.accentSubtle, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[styles.chipLabel, { color: theme.accent }]}>{label}</Text>
    </Pressable>
  );
}

const POLL_MS = 2000;

/**
 * An action the assistant prepared. Pending, it shows what will happen and
 * waits; confirmed, it is the server's to carry out, and the card asks after
 * it until the server says completed or failed. Done is never said sooner.
 */
export function ProposalCard({
  proposal,
  onChange,
}: {
  proposal: AiProposal;
  onChange: (proposal: AiProposal) => void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const now = useNow(1000);
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  const msLeft = Date.parse(proposal.expiresAt) - now.getTime();
  const state = proposal.state === 'pending' && msLeft <= 0 ? 'expired' : proposal.state;
  const running = state === 'confirmed' || state === 'executing';

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => {
      fetchAiAction(proposal.id)
        .then((fresh) => latest.current(fresh))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, proposal.id]);

  const act = (what: 'confirm' | 'reject') => {
    setBusy(what);
    setProblem(null);
    (what === 'confirm' ? confirmAiAction : rejectAiAction)(proposal.id)
      .then((fresh) => onChange(fresh))
      .catch((error: unknown) => setProblem(onlineFailureMessage(t, error)))
      .finally(() => setBusy(null));
  };

  const resultScreen =
    proposal.result === null ? null : screenForAppRoute(proposal.result.appRoute);
  const failure =
    proposal.errorCode === null ? undefined : apiErrorCodeMessage(proposal.errorCode, t);

  return (
    <View
      style={[styles.proposal, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
    >
      <Text style={[styles.proposalKicker, { color: theme.textMuted }]}>
        {t('mobile.ai.proposal.title')}
      </Text>
      <Text style={[styles.proposalTitle, { color: theme.text }]}>{proposal.preview.title}</Text>
      {proposal.preview.fields.map((field, index) => (
        <Detail key={index} label={field.label}>
          {field.value}
        </Detail>
      ))}
      {proposal.preview.warnings.length === 0 ? null : (
        <View style={styles.warnings}>
          <Text style={[styles.sourcesTitle, { color: theme.danger }]}>
            {t('mobile.ai.proposal.warnings')}
          </Text>
          {proposal.preview.warnings.map((warning, index) => (
            <Text key={index} style={[styles.text, { color: theme.danger }]}>
              {warning}
            </Text>
          ))}
        </View>
      )}

      {state === 'pending' ? (
        <>
          <Body muted>{t('mobile.ai.proposal.pending')}</Body>
          <Body muted>
            {msLeft < 60_000
              ? t('mobile.ai.proposal.expiresSoon')
              : t('mobile.ai.proposal.expiresIn', {
                  time: formatDuration(msLeft, i18n.language),
                })}
          </Body>
          <View style={styles.actions}>
            <Button
              label={t('mobile.ai.proposal.confirm')}
              busy={busy === 'confirm'}
              disabled={busy !== null}
              onPress={() => act('confirm')}
            />
            <Button
              label={t('mobile.ai.proposal.reject')}
              variant="secondary"
              busy={busy === 'reject'}
              disabled={busy !== null}
              onPress={() => act('reject')}
            />
          </View>
        </>
      ) : running ? (
        <View style={styles.running}>
          <ActivityIndicator color={theme.accent} />
          <Body muted>{t('mobile.ai.proposal.executing')}</Body>
        </View>
      ) : state === 'completed' ? (
        <>
          <Badge label={t('mobile.ai.proposal.completed')} tone="accent" />
          {proposal.result === null ? null : <Body>{proposal.result.summary}</Body>}
          {resultScreen === null ? null : (
            <View style={styles.actions}>
              <Button
                label={t('mobile.ai.proposal.open')}
                variant="secondary"
                onPress={() => router.push(resultScreen)}
              />
            </View>
          )}
        </>
      ) : state === 'failed' ? (
        <>
          <Badge label={t('mobile.ai.proposal.failed')} tone="danger" />
          {failure === undefined ? null : <Body muted>{failure}</Body>}
        </>
      ) : state === 'rejected' ? (
        <Badge label={t('mobile.ai.proposal.rejected')} tone="muted" />
      ) : (
        <Badge label={t('mobile.ai.proposal.expired')} tone="muted" />
      )}

      {problem === null ? null : (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
          {problem}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '88%',
    gap: spacing[2],
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  mine: { alignSelf: 'flex-end' },
  theirs: { alignSelf: 'flex-start', borderWidth: 1 },
  text: { fontSize: fontSize.sm, lineHeight: fontSize.sm * 1.5, textAlign: 'auto' },
  toolSummary: {
    fontSize: fontSize.xs,
    fontStyle: 'italic',
    textAlign: 'auto',
    paddingHorizontal: spacing[2],
  },
  sources: { gap: spacing[1] },
  sourcesTitle: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    textAlign: 'auto',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    borderRadius: radii.full,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  chipLabel: { fontSize: fontSize.xs, fontWeight: '600' },
  proposal: {
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  proposalKicker: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    textAlign: 'auto',
  },
  proposalTitle: { fontSize: fontSize.base, fontWeight: '600', textAlign: 'auto' },
  warnings: { gap: spacing[1] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  running: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  error: { fontSize: fontSize.xs, textAlign: 'auto' },
});
