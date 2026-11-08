import { formatDate, useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, useTheme } from './ui';

/**
 * A day, chosen with the phone's own calendar rather than typed: Android's
 * date dialog, or an inline calendar in a sheet on iOS. The value is
 * `YYYY-MM-DD` in the phone's calendar, as the forms store it.
 */

const pad = (value: number) => String(value).padStart(2, '0');
const dayOf = (at: Date) =>
  `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
/** Noon, so a day never slips across midnight on a clock change. */
const noonOf = (day: string) => new Date(`${day}T12:00:00`);
const VALID = /^\d{4}-\d{2}-\d{2}$/u;

export function DateField({
  label,
  value,
  onChange,
  minimum,
  maximum,
  error,
}: {
  label: string;
  /** `YYYY-MM-DD`, or empty for none yet. */
  value: string;
  onChange: (day: string) => void;
  /** `YYYY-MM-DD` bounds, inclusive. */
  minimum?: string;
  maximum?: string;
  error?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => (VALID.test(value) ? noonOf(value) : new Date()));

  const shown = VALID.test(value)
    ? formatDate(`${value}T12:00:00Z`, { locale: i18n.language, timeZone: 'UTC' })
    : t('mobile.fill.temporal.date');
  const limits = {
    ...(minimum === undefined ? {} : { minimumDate: noonOf(minimum) }),
    ...(maximum === undefined ? {} : { maximumDate: noonOf(maximum) }),
  };

  const choose = () => {
    const start = VALID.test(value) ? noonOf(value) : new Date();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: start,
        mode: 'date',
        ...limits,
        onChange: (event: DateTimePickerEvent, picked?: Date) => {
          if (event.type === 'set' && picked !== undefined) {
            onChange(dayOf(picked));
          }
        },
      });
      return;
    }
    setDraft(start);
    setOpen(true);
  };

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: shown }}
        onPress={choose}
        style={[
          styles.input,
          {
            backgroundColor: theme.surface,
            borderColor: error === undefined ? theme.border : theme.danger,
          },
        ]}
      >
        <Text style={[styles.value, { color: VALID.test(value) ? theme.text : theme.textMuted }]}>
          {shown}
        </Text>
      </Pressable>
      {error === undefined ? null : (
        <Text accessibilityRole="alert" style={[styles.error, { color: theme.danger }]}>
          {error}
        </Text>
      )}
      {Platform.OS === 'ios' ? (
        <Modal
          visible={open}
          transparent
          animationType="slide"
          onRequestClose={() => setOpen(false)}
        >
          <View style={styles.backdrop}>
            <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
              <DateTimePicker
                value={draft}
                mode="date"
                display="inline"
                {...limits}
                onChange={(_event: DateTimePickerEvent, picked?: Date) => {
                  if (picked !== undefined) {
                    setDraft(picked);
                  }
                }}
              />
              <Button
                label={t('mobile.fill.close')}
                onPress={() => {
                  setOpen(false);
                  onChange(dayOf(draft));
                }}
              />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.sm, fontWeight: '500', textAlign: 'auto' },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  value: { fontSize: fontSize.sm, textAlign: 'auto' },
  error: { fontSize: fontSize.xs, textAlign: 'auto' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  sheet: {
    gap: spacing[3],
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
});
