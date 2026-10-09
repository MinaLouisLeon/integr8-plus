import { offeredOptions, readDecimal, readInteger, say, toggleOffered } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import { BarcodeScanner } from './barcode';
import {
  ActionButton,
  ChoiceRow,
  Muted,
  styles as kit,
  TARGET,
  text,
  TextBox,
  type WidgetProps,
} from './kit';

/**
 * Text, numbers and choices.
 *
 * **Voice.** A text question takes dictation from the keyboard's own microphone,
 * which both platforms offer, works offline where the phone has an on-device
 * model, and needs no permission of this app. The field says so once, and turns
 * nothing off that dictation needs.
 */

export function TextWidget(props: WidgetProps<'text' | 'long_text'>) {
  const { field, value, label, invalid, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  const long = field.type === 'long_text';
  return (
    <View style={kit.stack}>
      <TextBox
        accessibilityLabel={label}
        accessibilityHint={t('mobile.fill.dictation')}
        value={text(value)}
        editable={!disabled}
        invalid={invalid}
        multiline={long}
        {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
        autoCapitalize="sentences"
        autoCorrect
        onChangeText={onAnswer}
        onBlur={onBlur}
      />
      {disabled ? null : <Muted>{t('mobile.fill.dictation')}</Muted>}
    </View>
  );
}

/** A serial number or asset tag: typed, or scanned with the camera straight into the field. */
export function BarcodeWidget(props: WidgetProps<'barcode'>) {
  const { field, value, label, invalid, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  return (
    <View style={kit.stack}>
      <View style={styles.inline}>
        <View style={styles.grow}>
          <TextBox
            accessibilityLabel={label}
            value={text(value)}
            editable={!disabled}
            invalid={invalid}
            {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
            // Nothing that would rewrite a serial.
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            onChangeText={onAnswer}
            onBlur={onBlur}
          />
        </View>
        {disabled ? null : (
          <ActionButton label={t('mobile.fill.barcode.scan')} onPress={() => setScanning(true)} />
        )}
      </View>
      {scanning ? (
        <BarcodeScanner
          onScanned={(data) => {
            setScanning(false);
            const code = field.maxLength === undefined ? data : data.slice(0, field.maxLength);
            onAnswer(code);
            onBlur();
          }}
          onCancel={() => setScanning(false)}
        />
      ) : null}
    </View>
  );
}

function WithUnit({ unit, children }: { unit: string | undefined; children: React.ReactNode }) {
  const theme = useTheme();
  return unit === undefined ? (
    <>{children}</>
  ) : (
    <View style={styles.inline}>
      <View style={styles.grow}>{children}</View>
      <Text style={[styles.unit, { color: theme.textMuted }]}>{unit}</Text>
    </View>
  );
}

export function NumberWidget(props: WidgetProps<'number'>) {
  const { field, value, label, invalid, disabled, onAnswer, onBlur } = props;
  const [typing, setTyping] = useState<string | undefined>(undefined);
  const shown = typing ?? (typeof value === 'number' ? String(value) : '');
  const unfinished = typing !== undefined && readInteger(typing).unfinished;
  return (
    <WithUnit unit={field.unit}>
      <TextBox
        accessibilityLabel={label}
        keyboardType="numbers-and-punctuation"
        value={shown}
        editable={!disabled}
        invalid={invalid || unfinished}
        onChangeText={(typed) => {
          const read = readInteger(typed);
          setTyping(read.text);
          if (read.answer !== undefined) {
            onAnswer(read.answer);
          }
        }}
        onBlur={() => {
          if (!unfinished) {
            setTyping(undefined);
          }
          onBlur();
        }}
      />
    </WithUnit>
  );
}

export function DecimalWidget(props: WidgetProps<'decimal'>) {
  const { field, value, label, invalid, disabled, onAnswer, onBlur } = props;
  return (
    <WithUnit unit={field.unit}>
      <TextBox
        accessibilityLabel={label}
        keyboardType="numbers-and-punctuation"
        value={text(value)}
        editable={!disabled}
        invalid={invalid}
        onChangeText={(typed) => onAnswer(readDecimal(typed))}
        onBlur={onBlur}
      />
    </WithUnit>
  );
}

/** A long list is a sheet of whole-width rows, not a tiny native spinner. */
export function DropdownWidget(props: WidgetProps<'dropdown'>) {
  const { field, value, label, invalid, available, disabled, locale, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const offered = offeredOptions(field.options, available);
  const chosen = offered.find((option) => option.value === value);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{
          text: chosen === undefined ? t('fill.choose') : say(chosen.label, locale),
        }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[
          kit.input,
          styles.select,
          {
            backgroundColor: disabled ? theme.surfaceMuted : theme.surface,
            borderColor: invalid ? theme.danger : theme.borderStrong,
          },
        ]}
      >
        <Text
          style={[
            styles.selectText,
            { color: chosen === undefined ? theme.textMuted : theme.text },
          ]}
        >
          {chosen === undefined ? t('fill.choose') : say(chosen.label, locale)}
        </Text>
        <Text style={{ color: theme.textMuted, fontSize: fontSize.lg }}>▾</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setOpen(false);
          onBlur();
        }}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { backgroundColor: theme.background }]}>
            <Text accessibilityRole="header" style={[styles.sheetTitle, { color: theme.text }]}>
              {label}
            </Text>
            <ScrollView contentContainerStyle={kit.stack}>
              {offered.map((option) => (
                <ChoiceRow
                  key={option.value}
                  role="radio"
                  label={say(option.label, locale)}
                  selected={option.value === value}
                  disabled={false}
                  onPress={() => {
                    onAnswer(option.value);
                    setOpen(false);
                    onBlur();
                  }}
                />
              ))}
            </ScrollView>
            <ActionButton
              label={t('mobile.fill.close')}
              onPress={() => {
                setOpen(false);
                onBlur();
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

export function RadioWidget(props: WidgetProps<'radio'>) {
  const { field, value, available, disabled, locale, onAnswer, onBlur } = props;
  return (
    <View accessibilityRole="radiogroup" style={kit.stack}>
      {offeredOptions(field.options, available).map((option) => (
        <ChoiceRow
          key={option.value}
          role="radio"
          label={say(option.label, locale)}
          selected={value === option.value}
          disabled={disabled}
          onPress={() => {
            onAnswer(option.value);
            onBlur();
          }}
        />
      ))}
    </View>
  );
}

export function MultiSelectWidget(props: WidgetProps<'multi_select'>) {
  const { field, value, available, disabled, locale, onAnswer, onBlur } = props;
  const selected = Array.isArray(value) ? (value as string[]) : [];
  return (
    <View style={kit.stack}>
      {offeredOptions(field.options, available).map((option) => {
        const ticked = selected.includes(option.value);
        return (
          <ChoiceRow
            key={option.value}
            role="checkbox"
            label={say(option.label, locale)}
            selected={ticked}
            disabled={disabled}
            onPress={() => {
              onAnswer(toggleOffered(field.options, available, selected, option.value, !ticked));
              onBlur();
            }}
          />
        );
      })}
    </View>
  );
}

/** A tick box is its own label: "I have isolated the gas supply." */
export function CheckboxWidget(props: WidgetProps<'checkbox'>) {
  const { value, label, disabled, onAnswer, onBlur } = props;
  return (
    <ChoiceRow
      role="checkbox"
      label={label}
      selected={value === true}
      disabled={disabled}
      onPress={() => {
        onAnswer(value !== true);
        onBlur();
      }}
    />
  );
}

export function YesNoWidget(props: WidgetProps<'yes_no'>) {
  const { field, value, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  const choices = [
    { value: 'yes', label: t('fill.yes') },
    { value: 'no', label: t('fill.no') },
    ...(field.allowNotApplicable === true
      ? [{ value: 'not_applicable', label: t('fill.notApplicable') }]
      : []),
  ];
  return (
    <View accessibilityRole="radiogroup" style={styles.segments}>
      {choices.map((choice) => (
        <Segment
          key={choice.value}
          label={choice.label}
          selected={value === choice.value}
          disabled={disabled}
          onPress={() => {
            onAnswer(choice.value);
            onBlur();
          }}
        />
      ))}
    </View>
  );
}

export function RatingWidget(props: WidgetProps<'rating'>) {
  const { field, value, disabled, onAnswer, onBlur } = props;
  const { t } = useTranslation();
  return (
    <View accessibilityRole="radiogroup" style={styles.segments}>
      {Array.from({ length: field.scale }, (_, index) => index + 1).map((score) => (
        <Segment
          key={score}
          label={String(score)}
          accessibilityLabel={t('fill.rating', { value: score, scale: field.scale })}
          selected={value === score}
          disabled={disabled}
          onPress={() => {
            onAnswer(score);
            onBlur();
          }}
        />
      ))}
    </View>
  );
}

function Segment({
  label,
  accessibilityLabel,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.segment,
        {
          backgroundColor: selected ? theme.accent : theme.surface,
          borderColor: selected ? theme.accent : theme.borderStrong,
          opacity: disabled ? 0.6 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.segmentLabel, { color: selected ? theme.onAccent : theme.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
  unit: { fontSize: fontSize.lg },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectText: { flex: 1, fontSize: fontSize.lg, textAlign: 'auto' },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.5)' },
  sheet: {
    maxHeight: '80%',
    gap: spacing[3],
    borderTopStartRadius: radii.lg,
    borderTopEndRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
  sheetTitle: { fontSize: fontSize.xl, fontWeight: '600', textAlign: 'auto' },
  segments: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  segment: {
    minWidth: TARGET,
    minHeight: TARGET,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
  },
  segmentLabel: { fontSize: fontSize.lg, fontWeight: '600' },
});
