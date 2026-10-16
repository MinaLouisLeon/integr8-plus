import { useTranslation } from '@integr8/i18n';
import { radii, spacing } from '@integr8/tokens';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { OnlineStatus } from '~/components/online';
import {
  BackButton,
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  ScrollScreen,
  useTheme,
} from '~/components/ui';
import { documentFileUrl, type DocumentRow, fetchDocuments } from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * The company's PDF documents (docs/documents ADR-0001 D8), read on the
 * phone: found by any of their fields, and opened in the browser. Online
 * only — a document is the office's to keep, so the phone holds no copy.
 * Expiring and deleting stay in the web and desktop apps.
 */
export default function DocumentsScreen() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const load = useCallback(() => fetchDocuments(searched), [searched]);
  const { state, reload } = useOnlineRequest(`documents:${searched}`, load);

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.documents.title')}</Heading>
      <Field
        label={t('mobile.documents.search')}
        value={text}
        returnKeyType="search"
        onChangeText={setText}
        onSubmitEditing={() => setSearched(text)}
      />
      {state.status !== 'ready' ? (
        <OnlineStatus state={state} onRetry={reload} />
      ) : state.data.length === 0 ? (
        <EmptyState
          title={searched === '' ? t('mobile.documents.emptyAll') : t('mobile.documents.empty')}
          body=""
        />
      ) : (
        state.data.map((document) => <DocumentCard key={document.id} document={document} />)
      )}
    </ScrollScreen>
  );
}

function DocumentCard({ document }: { document: DocumentRow }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [opening, setOpening] = useState(false);
  const language = i18n.language.startsWith('ar') ? 'ar' : 'en';
  const made = new Intl.DateTimeFormat(i18n.language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(document.createdAt));
  const state =
    document.status === 'pending'
      ? t('mobile.documents.pending')
      : document.status === 'failed'
        ? t('mobile.documents.failed')
        : document.linkOpens
          ? null
          : t('mobile.documents.expired');

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Body>{document.title}</Body>
      <Body muted>
        {t('mobile.documents.made', { date: made })}
        {state === null ? '' : ` · ${state}`}
      </Body>
      {document.fields.slice(0, 3).map((field) => (
        <Body key={field.key} muted>
          {(field.label[language] ?? field.label.en ?? field.key) + ': ' + field.value}
        </Body>
      ))}
      {document.status === 'ready' ? (
        <View style={styles.actions}>
          <Button
            label={t('mobile.documents.open')}
            variant="secondary"
            disabled={opening}
            onPress={() => {
              setOpening(true);
              documentFileUrl(document.id)
                .then((url) => (url === null ? undefined : WebBrowser.openBrowserAsync(url)))
                .catch(() => undefined)
                .finally(() => setOpening(false));
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  actions: { alignItems: 'flex-start', marginTop: spacing[2] },
});
