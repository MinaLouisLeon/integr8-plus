import { useTranslation } from '@integr8/i18n';
import { announcements, announcementText } from '@integr8/offline';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNow } from '~/lib/use-now';
import { dismissAnnouncement } from '~/local/announcements';
import { useLocalQuery } from '~/local/react';
import { useTheme } from './ui';

/**
 * What Integr8 has announced to this company (P15): planned maintenance, or a
 * reminder that the bill is overdue (P17), at the top of the day.
 *
 * Read from the phone, as `/v1/me` last said, so it shows with no signal; one
 * that has ended since goes by the phone's clock. Closing one hides it on this
 * phone only, and only where the announcement allows it.
 */
export function Announcements() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  // A minute is fine enough for an announcement's end, and keeps the query's key steady.
  const now = useNow(60_000);
  const minute = Math.floor(now.getTime() / 60_000);
  const state = useLocalQuery(`announcements:${String(minute)}`, ['meta'], (sql) =>
    announcements(sql, new Date(minute * 60_000)),
  );

  if (state.status !== 'ready' || state.data.length === 0) {
    return null;
  }

  return (
    <View style={styles.list}>
      {state.data.map((announcement) => {
        const colours = {
          info: { background: theme.accentSubtle, border: theme.accent },
          warning: { background: theme.warningSubtle, border: theme.warning },
          critical: { background: theme.dangerSubtle, border: theme.danger },
        }[announcement.severity];
        return (
          <View
            key={announcement.id}
            accessibilityRole={announcement.severity === 'info' ? 'summary' : 'alert'}
            style={[
              styles.banner,
              { backgroundColor: colours.background, borderColor: colours.border },
            ]}
          >
            <Text
              accessibilityLabel={`${t(`mobile.announcement.${announcement.severity}`)}: ${announcementText(announcement, i18n.language)}`}
              style={[styles.text, { color: theme.text }]}
            >
              {announcementText(announcement, i18n.language)}
            </Text>
            {announcement.dismissible ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void dismissAnnouncement(announcement.id)}
                hitSlop={8}
              >
                <Text style={[styles.action, { color: theme.accent }]}>
                  {t('mobile.announcement.dismiss')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  text: { flex: 1, fontSize: fontSize.sm, textAlign: 'auto' },
  action: { fontSize: fontSize.sm, fontWeight: '600' },
});
