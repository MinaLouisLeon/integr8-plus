import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import type { VanLot, VanStockRow } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BarcodeScanner } from '~/forms/widgets/barcode';
import { formatQuantity } from '~/lib/format';
import {
  batchShort,
  expiredChoice,
  isExpired,
  localDay,
  lotsLeft,
  type PartPick,
  serialByScan,
  toggleSerial,
} from '~/lib/lot-pick';
import { Badge, Body, Button, Section, useTheme } from './ui';

/**
 * The serial numbers or batches of a part being used, from the van's list
 * as the phone has it (ADR-0013). Serial numbers are ticked or scanned, one
 * per unit fitted; a batch is proposed — the earliest expiry — and may be
 * changed, or left to the office's choice. An expired batch is confirmed
 * here and explained in the note.
 */
export function PartLots({
  row,
  pick,
  today,
  onSerials,
  onBatch,
  onExpiredConfirmed,
}: {
  row: VanStockRow;
  pick: PartPick;
  today: string;
  onSerials: (serials: string[]) => void;
  onBatch: (lotId: string | null) => void;
  onExpiredConfirmed: (confirmed: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<string | null>(null);
  const unit = t(`inventory.unit.${row.item.unit}` as 'inventory.unit.each');
  const left = lotsLeft(row.lots);

  if (pick.tracking === 'serial') {
    return (
      <Section title={t('mobile.lots.serials')}>
        <Body muted>{t('mobile.lots.serialsHint')}</Body>
        <Button
          label={t('mobile.lots.scan')}
          variant="secondary"
          onPress={() => {
            setScanned(null);
            setScanning(true);
          }}
        />
        {scanned === null ? null : <Body>{scanned}</Body>}
        {left.length === 0 ? <Body muted>{t('mobile.lots.noneLeft')}</Body> : null}
        {left.map((lot) => (
          <Choice
            key={lot.lotId}
            role="checkbox"
            checked={pick.serials.includes(lot.lotId)}
            onPress={() => onSerials(toggleSerial(pick.serials, lot.lotId))}
            lot={lot}
          />
        ))}
        <Body muted>
          {pick.serials.length === 0
            ? t('mobile.lots.serialRequired')
            : t('mobile.lots.chosen', {
                number: formatQuantity(String(pick.serials.length), i18n.language, unit),
              })}
        </Body>
        {scanning ? (
          <BarcodeScanner
            onScanned={(data) => {
              setScanning(false);
              const found = serialByScan(row.lots, data);
              if (found === undefined) {
                setScanned(t('mobile.lots.notInVan', { code: data.trim() }));
                return;
              }
              if (!pick.serials.includes(found.lotId)) {
                onSerials([...pick.serials, found.lotId]);
              }
              setScanned(t('mobile.lots.scanned', { code: found.code }));
            }}
            onCancel={() => setScanning(false)}
          />
        ) : null}
      </Section>
    );
  }

  const expired = expiredChoice(pick, row.lots, today);
  return (
    <Section title={t('mobile.lots.batch')}>
      <Body muted>{t('mobile.lots.batchHint')}</Body>
      <Choice
        role="radio"
        checked={pick.batchId === null}
        onPress={() => onBatch(null)}
        label={t('mobile.lots.anyBatch')}
      />
      {left.length === 0 ? <Body muted>{t('mobile.lots.noneLeft')}</Body> : null}
      {left.map((lot) => (
        <Choice
          key={lot.lotId}
          role="radio"
          checked={pick.batchId === lot.lotId}
          onPress={() => onBatch(lot.lotId)}
          lot={lot}
          expired={isExpired(lot, today)}
          leftLine={t('mobile.lots.left', {
            quantity: formatQuantity(lot.forecast, i18n.language, unit),
          })}
        />
      ))}
      {batchShort(pick, row.lots) ? <Body muted>{t('mobile.lots.batchShort')}</Body> : null}
      {expired === undefined ? null : (
        <>
          <Body>
            {t('inventory.lots.expiredWarning', {
              code: expired.code,
              date: formatCalendarDate(expired.expiresOn!, { locale: i18n.language }),
            })}
          </Body>
          <Choice
            role="checkbox"
            checked={pick.expiredConfirmed}
            onPress={() => onExpiredConfirmed(!pick.expiredConfirmed)}
            label={t('mobile.lots.confirmExpired')}
          />
          <Body muted>{t('mobile.lots.noteWhy')}</Body>
        </>
      )}
    </Section>
  );
}

/** One serial number or batch to tick, or an option in words. */
function Choice({
  role,
  checked,
  onPress,
  lot,
  label,
  expired = false,
  leftLine,
}: {
  role: 'checkbox' | 'radio';
  checked: boolean;
  onPress: () => void;
  lot?: VanLot;
  label?: string;
  expired?: boolean;
  leftLine?: string;
}) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const mark = role === 'checkbox' ? (checked ? '☑' : '☐') : checked ? '◉' : '○';
  const title = lot?.code ?? label ?? '';
  const expiry =
    lot?.expiresOn === null || lot?.expiresOn === undefined
      ? null
      : t('inventory.lots.expires', {
          date: formatCalendarDate(lot.expiresOn, { locale: i18n.language }),
        });
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked }}
      accessibilityLabel={[title, expiry, leftLine].filter((part) => part != null).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        {
          borderColor: checked ? theme.accent : theme.border,
          backgroundColor: theme.surface,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.mark, { color: checked ? theme.accent : theme.textMuted }]}>{mark}</Text>
      <View style={styles.text}>
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        {expiry === null ? null : (
          <Text style={[styles.line, { color: theme.textMuted }]}>{expiry}</Text>
        )}
        {leftLine === undefined ? null : (
          <Text style={[styles.line, { color: theme.textMuted }]}>{leftLine}</Text>
        )}
        {expired ? <Badge label={t('inventory.lots.expired')} tone="danger" /> : null}
      </View>
    </Pressable>
  );
}

/**
 * The serial numbers or batches a van holds of an item, under its line: the
 * code, its expiry, and what is probably left after this phone's own uses.
 */
export function VanLots({ row }: { row: VanStockRow }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  if (row.item.tracking === 'none' || row.lots.length === 0) {
    return null;
  }
  const today = localDay(new Date());
  const unit = t(`inventory.unit.${row.item.unit}` as 'inventory.unit.each');
  return (
    <View style={styles.lots}>
      <Text style={[styles.line, { color: theme.textMuted }]}>
        {row.item.tracking === 'serial'
          ? t('inventory.lots.serialsLabel')
          : t('inventory.lots.batchesLabel')}
      </Text>
      {row.lots.map((lot) => (
        <View key={lot.lotId} style={styles.lotRow}>
          <Text style={[styles.line, { color: theme.text }]}>
            {[
              lot.code,
              lot.expiresOn === null
                ? null
                : t('inventory.lots.expires', {
                    date: formatCalendarDate(lot.expiresOn, { locale: i18n.language }),
                  }),
              t('mobile.lots.left', {
                quantity: formatQuantity(lot.forecast, i18n.language, unit),
              }),
            ]
              .filter((part) => part !== null)
              .join(' · ')}
          </Text>
          {isExpired(lot, today) ? (
            <Badge label={t('inventory.lots.expired')} tone="danger" />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  mark: { fontSize: 20 },
  text: { flex: 1, gap: spacing[1] },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  line: { fontSize: 14, textAlign: 'auto' },
  lots: { gap: spacing[1] },
  lotRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
});
