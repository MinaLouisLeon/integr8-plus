import { useTranslation } from '@integr8/i18n';
import { fontSize, radii } from '@integr8/tokens';
import { Image, StyleSheet, Text, View } from 'react-native';
import { localFile } from '~/local/sync-device';
import { useTheme } from './ui';

/**
 * An item's main image (ADR-0012), from the copy the phone downloaded after a
 * sync, so it shows with no signal. Until it has downloaded — or when the
 * item has none — a plain placeholder stands in its place.
 */
export function ItemImage({ path, name }: { path: string | null; name: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const stored = path === null ? undefined : localFile(path);
  const uri = stored?.exists === true ? stored.uri : undefined;
  return (
    <View
      style={[styles.frame, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
    >
      {uri === undefined ? (
        <Text
          accessibilityLabel={t('mobile.van.noPicture')}
          style={[styles.placeholder, { color: theme.textMuted }]}
        >
          {name.trim().slice(0, 1).toUpperCase()}
        </Text>
      ) : (
        <Image
          source={{ uri }}
          accessibilityLabel={t('mobile.van.pictureOf', { item: name })}
          style={styles.image}
          resizeMode="cover"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: 56,
    height: 56,
    borderWidth: 1,
    borderRadius: radii.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  placeholder: { fontSize: fontSize.xl, fontWeight: '600' },
});
