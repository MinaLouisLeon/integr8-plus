import { parseDate, parseDatetime, parseTime } from '@integr8/form-engine';
import { withOffset } from '@integr8/form-input';
import { formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import { ActionButton, styles as kit, text, type WidgetProps } from './kit';

/**
 * Dates and times with the phone's own pickers, which a person already knows
 * how to use with a thumb.
 *
 * What is stored is exactly what the desktop stores: `YYYY-MM-DD`, `HH:MM`, and
 * a date-time with this phone's UTC offset on that day (`@integr8/form-input`
 * writes it), because 14:05 in Cairo and in Frankfurt are different moments.
 */

const pad = (value: number) => String(value).padStart(2, '0');
const dateOf = (at: Date) =>
  `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const timeOf = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

function initial(type: 'date' | 'time' | 'datetime', value: string): Date {
  const now = new Date();
  if (value === '') {
    return now;
  }
  if (type === 'date' && parseDate(value) !== undefined) {
    return new Date(`${value}T12:00:00`);
  }
  if (type === 'time' && parseTime(value) !== undefined) {
    return new Date(`${dateOf(now)}T${value}:00`);
  }
  if (type === 'datetime' && parseDatetime(value) !== undefined) {
    return new Date(value);
  }
  return now;
}

function answerFor(type: 'date' | 'time' | 'datetime', at: Date): string {
  switch (type) {
    case 'date':
      return dateOf(at);
    case 'time':
      return timeOf(at);
    case 'datetime':
      return withOffset(`${dateOf(at)}T${timeOf(at)}`, -at.getTimezoneOffset());
  }
}

function bound(type: 'date' | 'time' | 'datetime', value: string | undefined): Date | undefined {
  if (value === undefined || type === 'time') {
    return undefined;
  }
  return type === 'date' ? new Date(`${value}T00:00:00`) : new Date(value);
}

export function TemporalWidget(props: WidgetProps<'date' | 'time' | 'datetime'>) {
  const { field, value, label, invalid, disabled, locale, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const type = field.type;
  const stored = text(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => initial(type, stored));

  const shown =
    stored === ''
      ? type === 'time'
        ? t('mobile.fill.temporal.time')
        : t('mobile.fill.temporal.date')
      : type === 'date'
        ? formatDate(`${stored}T12:00:00Z`, { locale, timeZone: 'UTC' })
        : type === 'time'
          ? stored
          : formatDateTime(stored, { locale });

  const minimumDate = bound(type, field.earliest);
  const maximumDate = bound(type, field.latest);
  const limits = {
    ...(minimumDate === undefined ? {} : { minimumDate }),
    ...(maximumDate === undefined ? {} : { maximumDate }),
  };

  const choose = () => {
    const start = initial(type, stored);
    if (Platform.OS === 'android') {
      // Android's pickers are dialogs, and date and time are separate ones.
      DateTimePickerAndroid.open({
        value: start,
        mode: type === 'time' ? 'time' : 'date',
        ...limits,
        onChange: (event: DateTimePickerEvent, picked?: Date) => {
          if (event.type !== 'set' || picked === undefined) {
            onBlur();
            return;
          }
          if (type !== 'datetime') {
            onAnswer(answerFor(type, picked));
            onBlur();
            return;
          }
          DateTimePickerAndroid.open({
            value: picked,
            mode: 'time',
            onChange: (timeEvent: DateTimePickerEvent, time?: Date) => {
              if (timeEvent.type === 'set' && time !== undefined) {
                onAnswer(answerFor(type, time));
              }
              onBlur();
            },
          });
        },
      });
      return;
    }
    setDraft(start);
    setOpen(true);
  };

  return (
    <View style={kit.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: shown }}
        disabled={disabled}
        onPress={choose}
        style={[
          kit.input,
          styles.value,
          {
            backgroundColor: disabled ? theme.surfaceMuted : theme.surface,
            borderColor: invalid ? theme.danger : theme.borderStrong,
          },
        ]}
      >
        <Text style={[styles.valueText, { color: stored === '' ? theme.textMuted : theme.text }]}>
          {shown}
        </Text>
      </Pressable>
      {stored === '' || disabled ? null : (
        <ActionButton
          tone="quiet"
          label={t('mobile.fill.temporal.clear')}
          onPress={() => {
            onClear();
            onBlur();
          }}
        />
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
                mode={type}
                display={type === 'date' ? 'inline' : 'spinner'}
                {...limits}
                onChange={(_event: DateTimePickerEvent, picked?: Date) => {
                  if (picked !== undefined) {
                    setDraft(picked);
                  }
                }}
              />
              <ActionButton
                tone="primary"
                label={t('mobile.fill.close')}
                onPress={() => {
                  setOpen(false);
                  onAnswer(answerFor(type, draft));
                  onBlur();
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
  value: { flexGrow: 1, justifyContent: 'center' },
  valueText: { fontSize: fontSize.lg, textAlign: 'auto' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  sheet: {
    gap: spacing[3],
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
});
