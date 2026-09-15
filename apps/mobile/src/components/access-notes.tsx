import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from './ui';

export interface Access {
  gateCode: string | null;
  parking: string | null;
  askFor: string | null;
  hazards: string | null;
  notes: string | null;
}

const present = (value: string | null): value is string => value !== null && value.trim() !== '';

/**
 * How to get in: the first thing on a job and on a site.
 *
 * Hazards come before anything else and in the danger colour, because they are
 * about the engineer's safety before they are about the job. The gate code is
 * large, because it is read at arm's length at a keypad, often with gloves on,
 * and always left-to-right whatever language the app is in.
 */
export function AccessNotes({ access }: { access: Access }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const any = [access.gateCode, access.parking, access.askFor, access.hazards, access.notes].some(
    present,
  );

  return (
    <View
      accessibilityRole="summary"
      style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.accent }]}
    >
      <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
        {t('operations.access.title')}
      </Text>

      {!any ? (
        <Text style={[styles.value, { color: theme.textMuted }]}>
          {t('operations.access.none')}
        </Text>
      ) : null}

      {present(access.hazards) ? (
        <View
          accessibilityRole="alert"
          style={[
            styles.hazards,
            { backgroundColor: theme.dangerSubtle, borderColor: theme.danger },
          ]}
        >
          <Text style={[styles.label, { color: theme.danger }]}>
            ⚠ {t('operations.access.hazards')}
          </Text>
          <Text style={[styles.value, { color: theme.text }]}>{access.hazards}</Text>
        </View>
      ) : null}

      {present(access.gateCode) ? (
        <View style={styles.item}>
          <Text style={[styles.label, { color: theme.textMuted }]}>
            {t('operations.access.gateCode')}
          </Text>
          <Text
            accessibilityLabel={access.gateCode.split('').join(' ')}
            style={[styles.code, { color: theme.text, writingDirection: 'ltr' }]}
          >
            {access.gateCode}
          </Text>
        </View>
      ) : null}

      {(
        [
          ['askFor', access.askFor],
          ['parking', access.parking],
          ['notes', access.notes],
        ] as const
      )
        .filter((entry): entry is readonly [(typeof entry)[0], string] => present(entry[1]))
        .map(([key, value]) => (
          <View key={key} style={styles.item}>
            <Text style={[styles.label, { color: theme.textMuted }]}>
              {t(`operations.access.${key}`)}
            </Text>
            <Text style={[styles.value, { color: theme.text }]}>{value}</Text>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing[3],
    borderWidth: 2,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  title: { fontSize: fontSize.lg, fontWeight: '600', textAlign: 'auto' },
  hazards: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  item: { gap: 2 },
  label: { fontSize: fontSize.sm, fontWeight: '600', textAlign: 'auto' },
  value: { fontSize: fontSize.base, textAlign: 'auto' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2, fontVariant: ['tabular-nums'] },
});
