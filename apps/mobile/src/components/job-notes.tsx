import { useTranslation } from '@integr8/i18n';
import type { WorkOrderDetail } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatWhen } from '~/lib/format';
import { refusalMessage } from '~/lib/refusals';
import { addNote } from '~/local/job-actions';
import { Body, Button, Field, Row, Section, useTheme } from './ui';

type Visibility = 'internal' | 'customer';

/**
 * The job's notes, and adding one (P12): "the gate code has changed", "the
 * customer wants a call before we come back". Saved on the phone and shown at
 * once, with no signal; sent when there is.
 *
 * A note is for the office unless the engineer says the customer may see it,
 * because a note that reaches a customer's report by default is one somebody
 * regrets. Notes are never edited or deleted, here or anywhere.
 */
export function JobNotes({ detail }: { detail: WorkOrderDetail }) {
  const { t, i18n } = useTranslation();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('internal');
  const [busy, setBusy] = useState(false);
  const canAdd = detail.can.comment;

  if (detail.comments.length === 0 && !canAdd) {
    return null;
  }

  const close = () => {
    setWriting(false);
    setText('');
    setVisibility('internal');
  };

  const save = async () => {
    setBusy(true);
    try {
      await addNote({ workOrderId: detail.workOrder.id, body: text, visibility });
      close();
    } catch (error) {
      Alert.alert(t('mobile.notes.failed'), refusalMessage(t, error, t('mobile.work.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('mobile.job.notes')}>
      {detail.comments.length === 0 ? <Body muted>{t('mobile.notes.none')}</Body> : null}
      {detail.comments.map((comment) => (
        <Row
          key={comment.id}
          title={comment.author.name}
          lines={[comment.body, formatWhen(comment.createdAt, i18n.language)]}
          tag={
            comment.visibility === 'internal'
              ? { label: t('mobile.job.internal'), tone: 'muted' }
              : undefined
          }
        />
      ))}

      {!canAdd ? null : writing ? (
        <View style={styles.form}>
          <Field
            label={t('mobile.notes.label')}
            placeholder={t('mobile.notes.placeholder')}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={10_000}
          />
          <View accessibilityRole="radiogroup" style={styles.choices}>
            <Choice
              label={t('mobile.notes.internal')}
              chosen={visibility === 'internal'}
              onPress={() => setVisibility('internal')}
            />
            <Choice
              label={t('mobile.notes.customer')}
              chosen={visibility === 'customer'}
              onPress={() => setVisibility('customer')}
            />
          </View>
          <Button
            label={t('mobile.notes.save')}
            busy={busy}
            disabled={text.trim() === ''}
            onPress={() => void save()}
          />
          <Button label={t('common.cancel')} variant="secondary" onPress={close} />
        </View>
      ) : (
        <Button
          label={t('mobile.notes.add')}
          variant="secondary"
          onPress={() => setWriting(true)}
        />
      )}
    </Section>
  );
}

function Choice({
  label,
  chosen,
  onPress,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      style={[
        styles.choice,
        {
          borderColor: chosen ? theme.accent : theme.border,
          backgroundColor: chosen ? theme.accent : theme.surface,
        },
      ]}
    >
      <Text style={{ color: chosen ? theme.onAccent : theme.text, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing[3] },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  choice: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
