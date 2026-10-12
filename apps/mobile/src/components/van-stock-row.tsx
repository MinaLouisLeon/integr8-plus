import { useTranslation } from '@integr8/i18n';
import type { VanStockRow } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatQuantity } from '~/lib/format';
import { ItemImage } from './item-image';
import { VanLots } from './part-lots';
import { useTheme } from './ui';

/**
 * One item on the engineer's van, offline (ADR-0012): its picture, what is on
 * hand, what is reserved for customers' orders and what is available —
 * available less this phone's own unsent uses, so it is a forecast like the
 * van's count always was. A tracked item lists its serial numbers or batches
 * (ADR-0013), each with what is probably left of it.
 */
export function VanStockItem({
  row,
  onPress,
}: {
  row: VanStockRow;
  onPress?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const unit = t(`inventory.unit.${row.item.unit}` as 'inventory.unit.each');
  const quantity = (value: string) => formatQuantity(value, i18n.language, unit);
  const body = (
    <View style={styles.inner}>
      <ItemImage path={row.imagePath} name={row.item.name} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: theme.text }]}>{row.item.name}</Text>
        <Text style={[styles.line, { color: theme.textMuted }]}>{row.item.sku}</Text>
        <Text style={[styles.line, { color: theme.text }]}>
          {t('mobile.van.onHand', { quantity: quantity(row.onHand) })}
        </Text>
        <Text style={[styles.line, { color: theme.textMuted }]}>
          {t('mobile.van.reserved', { quantity: quantity(row.reserved) })} ·{' '}
          {t('mobile.van.available', { quantity: quantity(row.availableForecast) })}
        </Text>
        <VanLots row={row} />
      </View>
    </View>
  );
  const style = [styles.row, { backgroundColor: theme.surface, borderColor: theme.border }];
  return onPress === undefined ? (
    <View style={style}>{body}</View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...style, { opacity: pressed ? 0.85 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  inner: { flexDirection: 'row', gap: spacing[3], alignItems: 'center' },
  text: { flex: 1, gap: spacing[1] },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  line: { fontSize: 14, textAlign: 'auto' },
});
