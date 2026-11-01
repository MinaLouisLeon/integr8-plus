import type { Information, LocalizedText } from '@integr8/form-engine';
import { informationText, say } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '~/components/ui';

/**
 * Text that is not a question (schema version 2), on the phone: an Information
 * block among the questions, and the description under a page or section
 * title. Plain text; a `Text` keeps its line breaks and reads nothing as markup.
 */
export function InformationBlock({ item, locale }: { item: Information; locale: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { heading, lines, style } = informationText(item, locale);
  const tone =
    style === 'warning'
      ? { backgroundColor: theme.warningSubtle, borderStartColor: theme.warning }
      : style === 'tip'
        ? { backgroundColor: theme.accentSubtle, borderStartColor: theme.accent }
        : undefined;
  const spoken = [
    style === 'plain' ? undefined : t(`fill.information.${style}`),
    heading,
    lines.join(' '),
  ]
    .filter((part) => part !== undefined && part !== '')
    .join('. ');
  return (
    <View
      accessible
      accessibilityLabel={spoken}
      testID={`information-${item.id}`}
      style={[styles.block, tone === undefined ? null : [styles.boxed, tone]]}
    >
      {heading === undefined ? null : (
        <Text style={[styles.heading, { color: theme.text }]}>{heading}</Text>
      )}
      <Text style={[styles.body, { color: theme.text }]}>{lines.join('\n')}</Text>
    </View>
  );
}

/** A page's or section's description, under its title. Nothing when it has none. */
export function Description({ text, locale }: { text: LocalizedText | undefined; locale: string }) {
  const theme = useTheme();
  const said = say(text, locale).trim();
  return said === '' ? null : (
    <Text style={[styles.description, { color: theme.textMuted }]}>{said}</Text>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing[1] },
  boxed: {
    borderStartWidth: 4,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  heading: { fontSize: fontSize.base, fontWeight: '600', textAlign: 'auto' },
  body: { fontSize: fontSize.base, textAlign: 'auto' },
  description: { fontSize: fontSize.sm, textAlign: 'auto' },
});
