import {
  type Field,
  type FieldError,
  formatDecimal,
  isCalculated,
  parseDecimal,
} from '@integr8/form-engine';
import { errorMessage, say } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { forwardRef, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';
import {
  BarcodeWidget,
  CheckboxWidget,
  DecimalWidget,
  DropdownWidget,
  MultiSelectWidget,
  NumberWidget,
  RadioWidget,
  RatingWidget,
  TextWidget,
  YesNoWidget,
} from './widgets/basic';
import { FilesWidget } from './widgets/files';
import { GpsWidget } from './widgets/gps';
import type { WidgetProps } from './widgets/kit';
import { SignatureWidget } from './widgets/signature';
import { TemporalWidget } from './widgets/temporal';

/**
 * One question: its label, help, control and errors. Which control is the only
 * thing that depends on the field's type, and every type in the registry has
 * one — the switch below is exhaustive, so a new type is a compile error here
 * until the phone can answer it.
 */

export interface FieldBlockProps {
  field: Field;
  value: unknown;
  errors: readonly FieldError[];
  locale: string;
  disabled: boolean;
  onAnswer: (value: unknown) => void;
  onClear: () => void;
  onBlur: () => void;
}

export const FieldBlock = forwardRef<View, FieldBlockProps>(function FieldBlock(props, ref) {
  const { field, value, errors, locale, disabled, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const label = say(field.label, locale) || field.id;
  const translate = t as unknown as (key: string, params: Record<string, string>) => string;

  const heading = (
    <Text style={[styles.label, { color: theme.text }]}>
      {label}
      {field.required === true ? (
        <Text accessibilityLabel={` (${t('fill.required')})`} style={{ color: theme.danger }}>
          {' *'}
        </Text>
      ) : null}
    </Text>
  );
  const help =
    field.help === undefined ? null : (
      <Text style={[styles.help, { color: theme.textMuted }]}>{say(field.help, locale)}</Text>
    );
  const messages =
    errors.length === 0 ? null : (
      <View accessibilityLiveRegion="polite" style={styles.errors}>
        {errors.map((error) => (
          <Text
            key={`${error.code}-${error.params.rule ?? ''}`}
            style={[styles.error, { color: theme.danger }]}
          >
            {errorMessage(field, error, locale, translate)}
          </Text>
        ))}
      </View>
    );

  if (isCalculated(field)) {
    return (
      <View ref={ref} style={styles.block}>
        {heading}
        {help}
        <View
          accessible
          accessibilityLabel={`${label}: ${calculatedText(field, value) || '—'}`}
          style={[styles.calculated, { backgroundColor: theme.surfaceMuted }]}
        >
          <Text style={[styles.calculatedValue, { color: theme.text }]}>
            {calculatedText(field, value) || '—'}
            {'unit' in field && field.unit !== undefined && value !== undefined
              ? ` ${field.unit}`
              : ''}
          </Text>
        </View>
        <Text style={[styles.help, { color: theme.textMuted }]}>{t('fill.calculated')}</Text>
      </View>
    );
  }

  const widgetProps: WidgetProps = {
    field,
    value,
    label,
    invalid: errors.length > 0,
    disabled: disabled || field.readOnly === true,
    locale,
    onAnswer,
    onClear,
    onBlur,
  };

  return (
    <View
      ref={ref}
      style={[styles.block, errors.length > 0 ? { borderStartColor: theme.danger } : null]}
    >
      {field.type === 'checkbox' ? null : heading}
      {help}
      {widget(widgetProps)}
      {messages}
    </View>
  );
});

function widget(props: WidgetProps): ReactNode {
  switch (props.field.type) {
    case 'text':
    case 'long_text':
      return <TextWidget {...(props as WidgetProps<'text' | 'long_text'>)} />;
    case 'barcode':
      return <BarcodeWidget {...(props as WidgetProps<'barcode'>)} />;
    case 'number':
      return <NumberWidget {...(props as WidgetProps<'number'>)} />;
    case 'decimal':
      return <DecimalWidget {...(props as WidgetProps<'decimal'>)} />;
    case 'date':
    case 'time':
    case 'datetime':
      return <TemporalWidget {...(props as WidgetProps<'date' | 'time' | 'datetime'>)} />;
    case 'dropdown':
      return <DropdownWidget {...(props as WidgetProps<'dropdown'>)} />;
    case 'radio':
      return <RadioWidget {...(props as WidgetProps<'radio'>)} />;
    case 'multi_select':
      return <MultiSelectWidget {...(props as WidgetProps<'multi_select'>)} />;
    case 'checkbox':
      return <CheckboxWidget {...(props as WidgetProps<'checkbox'>)} />;
    case 'yes_no':
      return <YesNoWidget {...(props as WidgetProps<'yes_no'>)} />;
    case 'rating':
      return <RatingWidget {...(props as WidgetProps<'rating'>)} />;
    case 'signature':
      return <SignatureWidget {...(props as WidgetProps<'signature'>)} />;
    case 'photo':
    case 'file':
      return <FilesWidget {...(props as WidgetProps<'photo' | 'file'>)} />;
    case 'gps':
      return <GpsWidget {...(props as WidgetProps<'gps'>)} />;
  }
}

function calculatedText(field: Field, value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (field.type === 'decimal' && typeof value === 'string') {
    const parsed = parseDecimal(value);
    return parsed === undefined ? value : formatDecimal(parsed);
  }
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

const styles = StyleSheet.create({
  block: {
    gap: spacing[2],
    borderStartWidth: 3,
    borderStartColor: 'transparent',
    paddingStart: spacing[3],
  },
  label: { fontSize: fontSize.lg, fontWeight: '600', textAlign: 'auto' },
  help: { fontSize: fontSize.sm, textAlign: 'auto' },
  errors: { gap: spacing[1] },
  error: { fontSize: fontSize.base, fontWeight: '600', textAlign: 'auto' },
  calculated: {
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  calculatedValue: { fontSize: fontSize.lg, textAlign: 'auto' },
});
