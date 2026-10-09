import { fontSize, radii, spacing } from '@integr8/tokens';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBrand } from './brand';
import { useTheme } from './ui';

/**
 * A slim bar in the company's shell colour: the logo when it is known, the
 * name, and one action at the end of the row. The fallbacks run shell → accent
 * → surface, so the bar always reads against what it is painted on.
 *
 * A plain `flexDirection: 'row'`: React Native mirrors rows under RTL, so the
 * action lands at the end in Arabic without any direction-specific style.
 */
export function BrandHeader({
  action,
  compact = false,
}: {
  action?: { label: string; onPress: () => void } | undefined;
  /** Inside a screen that already pads the status bar. */
  compact?: boolean;
}) {
  const brand = useBrand();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const background = brand.shell?.shell ?? brand.accent?.accent ?? theme.surface;
  const text =
    brand.shell?.shellText ?? (brand.accent === null ? theme.text : brand.accent.onAccent);
  const border = brand.shell?.shellBorder ?? (brand.accent === null ? theme.border : background);

  return (
    <View
      style={[
        styles.bar,
        compact ? styles.compact : { paddingTop: insets.top + spacing[2] },
        { backgroundColor: background, borderBottomColor: border },
      ]}
    >
      {brand.logoUrl === null ? null : (
        <Image
          source={{ uri: brand.logoUrl }}
          style={styles.logo}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      )}
      <Text numberOfLines={1} style={[styles.name, { color: text }]}>
        {brand.name}
      </Text>
      {action === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          hitSlop={6}
          style={({ pressed }) => [
            styles.action,
            { borderColor: text, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.actionLabel, { color: text }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  compact: { paddingTop: spacing[2], borderRadius: radii.md, borderBottomWidth: 0 },
  logo: { width: 32, height: 32, borderRadius: radii.sm },
  name: { flex: 1, fontSize: fontSize.base, fontWeight: '600', textAlign: 'auto' },
  action: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  actionLabel: { fontSize: fontSize.sm, fontWeight: '600' },
});
