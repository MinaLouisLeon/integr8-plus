import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AllowanceLine, AssistantOffline, MessageBubble } from '~/components/assistant';
import { onlineFailureMessage, OnlineStatus } from '~/components/online';
import {
  BackButton,
  Badge,
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  useTheme,
} from '~/components/ui';
import {
  type Allowance,
  assistantLocale,
  MAX_QUESTION_CHARS,
  quotaResetsAt,
  sendBlock,
} from '~/lib/assistant';
import { formatWhen } from '~/lib/format';
import { useNow } from '~/lib/use-now';
import {
  type AiMessage,
  type AiProposal,
  fetchAiCapabilities,
  fetchAiConversation,
  newIdempotencyKey,
  sendAiMessage,
} from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * One conversation with the assistant (docs/ai §10.4): its messages, and a
 * place to ask the next question. Online only: a question is sent now or
 * not at all, and is never queued. A send that fails keeps the words in the
 * box and says why; sending them again reuses the same key, so a question
 * that did arrive is answered once and charged once.
 */
export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { state, reload } = useOnlineRequest(`assistant:${conversationId}`, () =>
    loadConversation(conversationId),
  );

  /** What this screen added since the read: answers, the latest allowance, and actions as they moved. */
  const [local, setLocal] = useState<{
    added: AiMessage[];
    proposals: Readonly<Record<string, AiProposal>>;
    allowance: Allowance | null;
  }>({ added: [], proposals: {}, allowance: null });
  const [text, setText] = useState('');
  const [attempt, setAttempt] = useState<{ key: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** When a refused question may be asked again, from the refusal itself. */
  const [refusedUntil, setRefusedUntil] = useState<string | null>(null);
  const now = useNow(30_000);
  const list = useRef<FlatList<AiMessage>>(null);

  const onProposalChange = useCallback((proposal: AiProposal) => {
    setLocal((current) => ({
      ...current,
      proposals: { ...current.proposals, [proposal.id]: proposal },
    }));
  }, []);

  const header = (
    title: string | null,
    level?: 'help' | 'insights' | 'agent',
    allowance?: Allowance,
  ) => (
    <View
      style={[
        styles.header,
        {
          backgroundColor: theme.surface,
          borderBottomColor: theme.border,
          paddingTop: insets.top + spacing[3],
        },
      ]}
    >
      <BackButton />
      <Heading>{title ?? t('mobile.ai.untitled')}</Heading>
      {level === undefined ? null : (
        <View style={styles.level}>
          <Badge label={t(`mobile.ai.level.${level}`)} tone="accent" />
        </View>
      )}
      {allowance === undefined ? null : <AllowanceLine allowance={allowance} />}
    </View>
  );

  if (state.status !== 'ready') {
    return (
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        {header(null)}
        <View style={styles.body}>
          {state.status === 'offline' ? (
            <AssistantOffline onRetry={reload} />
          ) : (
            <OnlineStatus state={state} onRetry={reload} />
          )}
        </View>
      </View>
    );
  }

  const { capabilities, conversation } = state.data;
  if (capabilities.level === 'off') {
    return (
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        {header(conversation.title)}
        <View style={styles.body}>
          <EmptyState
            title={t('mobile.ai.off.title')}
            body={t(`mobile.ai.off.${capabilities.blockedBy ?? 'not_served'}`)}
          />
        </View>
      </View>
    );
  }

  // Each answer carries what is left after it, so the line moves without a re-read.
  const allowance = local.allowance ?? capabilities.usage.allowance;
  const known = new Set(state.data.messages.map((message) => message.id));
  const messages = [
    ...state.data.messages,
    ...local.added.filter((message) => !known.has(message.id)),
  ].map((message) => {
    const moved =
      message.actionProposal === null ? undefined : local.proposals[message.actionProposal.id];
    return moved === undefined ? message : { ...message, actionProposal: moved };
  });
  const shown =
    sending && attempt !== null
      ? [...messages, pendingMessage(attempt.key, attempt.text)]
      : messages;

  const blocked = sendBlock(allowance, refusedUntil, now.getTime());
  const question = text.trim();
  const number = new Intl.NumberFormat(i18n.language);

  const send = () => {
    if (question === '' || sending || blocked !== null) {
      return;
    }
    // The same question again is the same request: one key, one answer, one charge.
    const key = attempt !== null && attempt.text === question ? attempt.key : newIdempotencyKey();
    setAttempt({ key, text: question });
    setSending(true);
    setSendError(null);
    sendAiMessage({
      conversationId,
      message: question,
      locale: assistantLocale(i18n.language),
      key,
    })
      .then((answer) => {
        setLocal((current) => ({
          ...current,
          added: [...current.added, pendingMessage(key, question), answer.message],
          allowance: answer.allowance,
        }));
        setText('');
        setAttempt(null);
      })
      .catch((error: unknown) => {
        const resetsAt = quotaResetsAt(error);
        if (resetsAt !== null) {
          setRefusedUntil(resetsAt);
          // The refusal is the newest word on the allowance: the line above says used up too.
          setLocal((current) => ({
            ...current,
            allowance: { ...allowance, exhausted: true, resetsAt },
          }));
          setSendError(t('mobile.ai.quotaExceeded', { when: formatWhen(resetsAt, i18n.language) }));
        } else {
          setSendError(t('mobile.ai.notSent', { reason: onlineFailureMessage(t, error) }));
        }
      })
      .finally(() => setSending(false));
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {header(conversation.title, capabilities.level, allowance)}
      <FlatList
        ref={list}
        data={shown}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => (
          <MessageBubble message={item} onProposalChange={onProposalChange} />
        )}
        style={styles.grow}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={<Body muted>{t('mobile.ai.threadEmpty')}</Body>}
      />
      <View
        style={[
          styles.composer,
          {
            backgroundColor: theme.surface,
            borderTopColor: theme.border,
            paddingBottom: insets.bottom + spacing[3],
          },
        ]}
      >
        {blocked === null ? null : (
          <Body muted>
            {blocked.resetsAt === null
              ? t('mobile.ai.exhaustedNoTime')
              : t('mobile.ai.exhausted', { when: formatWhen(blocked.resetsAt, i18n.language) })}
          </Body>
        )}
        <Field
          label={t('mobile.ai.question')}
          placeholder={t('mobile.ai.placeholder')}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={MAX_QUESTION_CHARS}
          editable={!sending && blocked === null}
          error={sendError ?? undefined}
        />
        <View style={styles.sendRow}>
          <Body muted>
            {t('mobile.ai.counter', {
              used: number.format(text.length),
              max: number.format(MAX_QUESTION_CHARS),
            })}
          </Body>
          <Button
            label={sending ? t('mobile.ai.sending') : t('mobile.ai.send')}
            busy={sending}
            disabled={question === '' || blocked !== null}
            onPress={send}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** The conversation and what the assistant may do now, read together. */
async function loadConversation(conversationId: string) {
  const [capabilities, thread] = await Promise.all([
    fetchAiCapabilities(),
    fetchAiConversation(conversationId),
  ]);
  return { capabilities, ...thread };
}

/** The person's own question as a bubble, before and after the server has it. */
function pendingMessage(key: string, text: string): AiMessage {
  return {
    id: `local:${key}`,
    role: 'user',
    text,
    sources: [],
    toolSummaries: [],
    actionProposal: null,
    createdAt: new Date().toISOString(),
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grow: { flex: 1 },
  header: {
    gap: spacing[2],
    borderBottomWidth: 1,
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  level: { flexDirection: 'row' },
  body: { gap: spacing[4], paddingHorizontal: spacing[4], paddingVertical: spacing[6] },
  thread: { gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[4] },
  composer: {
    gap: spacing[2],
    borderTopWidth: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  sendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
