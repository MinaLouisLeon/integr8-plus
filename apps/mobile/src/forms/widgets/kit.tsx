import type { FieldOf, FieldType } from '@integr8/form-engine';
import { fontSize, radii, spacing } from '@integr8/tokens';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '~/components/ui';

/**
 * What every widget is given, and the pieces they are built from.
 *
 * A widget turns a touch into an answer and nothing more: it never decides what
 * is visible, valid or worked out — `FillModel` asks the engine. Controls are
 * sized for gloved hands: nothing tappable is under 56 points tall, choices are
 * whole-width rows rather than small circles, and the text is large enough to
 * read at arm's length.
 */

export interface WidgetProps<T extends FieldType = FieldType> {
  field: FieldOf<T>;
  value: unknown;
  /** The question as shown, for naming controls to a screen reader. */
  label: string;
  invalid: boolean;
  /** For a choice whose options depend on another answer: the values on offer. `undefined` offers all. */
  available: readonly string[] | undefined;
  disabled: boolean;
  locale: string;
  onAnswer: (value: unknown) => void;
  onClear: () => void;
  onBlur: () => void;
}

export const TARGET = 56;

export function TextBox({
  invalid,
  multiline = false,
  ...rest
}: TextInputProps & { invalid: boolean; multiline?: boolean }) {
  const theme = useTheme();
  return (
    <TextInput
      {...rest}
      multiline={multiline}
      placeholderTextColor={theme.textMuted}
      style={[
        styles.input,
        multiline ? styles.multiline : null,
        {
          backgroundColor: rest.editable === false ? theme.surfaceMuted : theme.surface,
          borderColor: invalid ? theme.danger : theme.borderStrong,
          color: theme.text,
        },
      ]}
    />
  );
}

/** A whole-width row to tap: one option of a choice, a tick box. */
export function ChoiceRow({
  label,
  selected,
  role,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  role: 'radio' | 'checkbox';
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          backgroundColor: selected ? theme.accentSubtle : theme.surface,
          borderColor: selected ? theme.accent : theme.border,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View
        style={[
          role === 'radio' ? styles.radioMark : styles.checkMark,
          {
            borderColor: selected ? theme.accent : theme.borderStrong,
            backgroundColor: selected && role === 'checkbox' ? theme.accent : 'transparent',
          },
        ]}
      >
        {selected && role === 'radio' ? (
          <View style={[styles.radioDot, { backgroundColor: theme.accent }]} />
        ) : null}
        {selected && role === 'checkbox' ? (
          <Text style={[styles.tick, { color: theme.onAccent }]}>✓</Text>
        ) : null}
      </View>
      <Text style={[styles.choiceLabel, { color: theme.text }]}>{label}</Text>
    </Pressable>
  );
}

/** A button inside a question: take a photo, scan, use my location. */
export function ActionButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  tone = 'secondary',
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'primary' | 'secondary' | 'quiet';
  accessibilityHint?: string;
}) {
  const theme = useTheme();
  const colours =
    tone === 'primary'
      ? { background: theme.accent, border: theme.accent, text: theme.onAccent }
      : tone === 'quiet'
        ? { background: 'transparent', border: 'transparent', text: theme.accent }
        : { background: theme.surface, border: theme.borderStrong, text: theme.text };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: colours.background,
          borderColor: colours.border,
          opacity: disabled || busy ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.actionLabel, { color: colours.text }]}>{label}</Text>
    </Pressable>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.muted, { color: theme.textMuted }]}>{children}</Text>;
}

export function Problem({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text accessibilityLiveRegion="polite" style={[styles.muted, { color: theme.danger }]}>
      {children}
    </Text>
  );
}

export const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const styles = StyleSheet.create({
  input: {
    minHeight: TARGET,
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: fontSize.lg,
    textAlign: 'auto',
  },
  multiline: { minHeight: TARGET * 2, textAlignVertical: 'top' },
  choice: {
    minHeight: TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  choiceLabel: { flex: 1, fontSize: fontSize.lg, textAlign: 'auto' },
  radioMark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 14, height: 14, borderRadius: 7 },
  checkMark: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: { fontSize: fontSize.lg, fontWeight: '700' },
  action: {
    minHeight: TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  actionLabel: { fontSize: fontSize.base, fontWeight: '600' },
  muted: { fontSize: fontSize.sm, textAlign: 'auto' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  stack: { gap: spacing[2] },
});
