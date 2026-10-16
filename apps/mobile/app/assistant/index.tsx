import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { AllowanceLine, AssistantOffline } from '~/components/assistant';
import { onlineFailureMessage, OnlineStatus } from '~/components/online';
import {
  BackButton,
  Badge,
  Body,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { assistantLocale } from '~/lib/assistant';
import { formatWhen } from '~/lib/format';
import {
  type AiConversation,
  createAiConversation,
  deleteAiConversation,
  fetchAiCapabilities,
  fetchAiConversations,
} from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * The assistant's front door (docs/ai §10.4): what it may do for this
 * person, how much is left, and their conversations. Online only — with no
 * connection it says so and offers nothing, because nothing here is kept on
 * the phone. Off is an answer: the screen says which switch closed it.
 */
export default function AssistantScreen() {
  const { t, i18n } = useTranslation();
  const { state, reload } = useOnlineRequest('assistant', loadAssistant);
  const [starting, setStarting] = useState(false);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  // Coming back from a conversation, the list is asked again: a title may have arrived.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  const open = (id: string) => router.push({ pathname: '/assistant/[id]', params: { id } });

  const start = () => {
    setStarting(true);
    setProblem(null);
    createAiConversation(assistantLocale(i18n.language))
      .then((conversation) => open(conversation.id))
      .catch((error: unknown) => setProblem(onlineFailureMessage(t, error)))
      .finally(() => setStarting(false));
  };

  const remove = (conversation: AiConversation) => {
    Alert.alert(t('mobile.ai.deleteTitle'), t('mobile.ai.deleteBody'), [
      { text: t('mobile.ai.keep'), style: 'cancel' },
      {
        text: t('mobile.ai.delete'),
        style: 'destructive',
        onPress: () => {
          setProblem(null);
          deleteAiConversation(conversation.id)
            .then(() => setRemoved((ids) => [...ids, conversation.id]))
            .catch((error: unknown) => setProblem(onlineFailureMessage(t, error)));
        },
      },
    ]);
  };

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.ai.title')}</Heading>
      <Body muted>{t('mobile.ai.intro')}</Body>

      {state.status === 'offline' ? (
        <AssistantOffline onRetry={reload} />
      ) : state.status !== 'ready' ? (
        <OnlineStatus state={state} onRetry={reload} />
      ) : state.data.capabilities.level === 'off' ? (
        <EmptyState
          title={t('mobile.ai.off.title')}
          body={t(`mobile.ai.off.${state.data.capabilities.blockedBy ?? 'not_served'}`)}
        />
      ) : (
        <>
          <View style={styles.level}>
            <Badge label={t(`mobile.ai.level.${state.data.capabilities.level}`)} tone="accent" />
          </View>
          <AllowanceLine allowance={state.data.capabilities.usage.allowance} />
          {problem === null ? null : <ErrorState message={problem} />}
          <Button label={t('mobile.ai.newConversation')} busy={starting} onPress={start} />
          {state.data.conversations.filter((c) => !removed.includes(c.id)).length === 0 ? (
            <EmptyState title={t('mobile.ai.empty')} body={t('mobile.ai.emptyBody')} />
          ) : (
            <Section title={t('mobile.ai.conversations')}>
              {state.data.conversations
                .filter((conversation) => !removed.includes(conversation.id))
                .map((conversation) => (
                  <View key={conversation.id} style={styles.conversation}>
                    <View style={styles.grow}>
                      <Row
                        title={conversation.title ?? t('mobile.ai.untitled')}
                        lines={[formatWhen(conversation.updatedAt, i18n.language)]}
                        onPress={() => open(conversation.id)}
                      />
                    </View>
                    <Button
                      label={t('mobile.ai.delete')}
                      variant="secondary"
                      onPress={() => remove(conversation)}
                    />
                  </View>
                ))}
            </Section>
          )}
        </>
      )}
    </ScrollScreen>
  );
}

/** What the assistant may do, and the conversations so far — none asked for when it is off. */
async function loadAssistant() {
  const capabilities = await fetchAiCapabilities();
  const conversations = capabilities.level === 'off' ? [] : await fetchAiConversations();
  return { capabilities, conversations };
}

const styles = StyleSheet.create({
  level: { flexDirection: 'row' },
  conversation: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
});
