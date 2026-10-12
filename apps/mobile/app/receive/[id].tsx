import { useTranslation } from '@integr8/i18n';
import { radii, spacing } from '@integr8/tokens';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { onlineFailureMessage, OnlineStatus } from '~/components/online';
import {
  BackButton,
  Badge,
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { BarcodeScanner } from '~/forms/widgets/barcode';
import { formatQuantity } from '~/lib/format';
import {
  counted,
  outstanding,
  receiptLines,
  scan,
  setCount,
  type Tally,
} from '~/lib/receive-tally';
import {
  fetchPurchaseOrder,
  fetchWarehouses,
  lookupBarcode,
  type PurchaseOrder,
  receiveGoods,
} from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * Receiving one purchase order at the store by scanning (ADR-0012). Each scan
 * of an item's barcode — with the camera scanner the phone uses for asset
 * tags — adds one to its line; a quantity can be typed instead. Each line
 * shows what was ordered, what earlier deliveries brought and what is counted
 * now, and an item not on the order, or more than the order has left, is
 * said at once and not counted. Then the receipt is recorded. Online only.
 */
export default function ReceiveOrderScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, reload } = useOnlineRequest(`order:${id}`, () => fetchPurchaseOrder(id));

  if (state.status !== 'ready') {
    return (
      <ScrollScreen>
        <BackButton />
        <Heading>{t('mobile.receive.title')}</Heading>
        <OnlineStatus state={state} onRetry={reload} />
      </ScrollScreen>
    );
  }
  // A fresh count for each version of the order: after a receipt, it starts again.
  return <Receive key={state.data.order.version} order={state.data} onChanged={reload} />;
}

type Notice = { tone: 'ok' | 'warn'; text: string } | null;

function Receive({ order, onChanged }: { order: PurchaseOrder; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [tally, setTally] = useState<Tally>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [scanning, setScanning] = useState(false);
  const [looking, setLooking] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [supplierNote, setSupplierNote] = useState('');
  const [busy, setBusy] = useState(false);
  const needsLocation = order.order.deliveryLocation === null;
  const warehouses = useOnlineRequest(`warehouses:${String(needsLocation)}`, () =>
    needsLocation ? fetchWarehouses() : Promise.resolve([]),
  );

  const { lines } = order;
  const unit = (code: string) => t(`inventory.unit.${code}` as 'inventory.unit.each');
  const quantity = (value: string, code: string) =>
    formatQuantity(value, i18n.language, unit(code));

  if (!order.can.receive) {
    return (
      <ScrollScreen>
        <BackButton />
        <Heading>{`${order.order.reference} · ${order.order.supplier.name}`}</Heading>
        <EmptyState
          title={t(`purchasing.status.${order.order.status}`)}
          body={t('mobile.receive.notAllowed')}
        />
      </ScrollScreen>
    );
  }

  const counting = (next: Tally, lineId: string) => {
    setTally(next);
    setDrafts(({ [lineId]: _typed, ...rest }) => rest);
    setErrors(({ [lineId]: _error, ...rest }) => rest);
  };

  const scanned = (barcode: string) => {
    setScanning(false);
    setLooking(true);
    lookupBarcode(barcode.trim())
      .then((item) => {
        if (item === undefined) {
          setNotice({ tone: 'warn', text: t('mobile.receive.unknownBarcode', { code: barcode }) });
          return;
        }
        const result = scan(lines, tally, item.id);
        if (result.outcome === 'added') {
          counting(result.tally, result.lineId);
          setNotice({ tone: 'ok', text: t('mobile.receive.added', { item: item.name }) });
        } else if (result.outcome === 'over') {
          setNotice({ tone: 'warn', text: t('mobile.receive.over', { item: item.name }) });
        } else {
          setNotice({ tone: 'warn', text: t('mobile.receive.notOnOrder', { item: item.name }) });
        }
      })
      .catch((error: unknown) => setNotice({ tone: 'warn', text: onlineFailureMessage(t, error) }))
      .finally(() => setLooking(false));
  };

  const typed = (lineId: string, text: string) => {
    setDrafts((all) => ({ ...all, [lineId]: text }));
    const result = setCount(lines, tally, lineId, text.trim() === '' ? '0' : text);
    if (result.outcome === 'set') {
      setTally(result.tally);
      setErrors(({ [lineId]: _error, ...rest }) => rest);
    } else {
      setErrors((all) => ({
        ...all,
        [lineId]:
          result.outcome === 'over'
            ? t('mobile.receive.overTyped', { quantity: result.outstanding })
            : t('mobile.receive.invalid'),
      }));
    }
  };

  const record = () => {
    const toReceive = receiptLines(lines, tally);
    if (toReceive.length === 0) {
      setNotice({ tone: 'warn', text: t('mobile.receive.nothingCounted') });
      return;
    }
    if (needsLocation && locationId === null) {
      setNotice({ tone: 'warn', text: t('mobile.receive.chooseLocation') });
      return;
    }
    setBusy(true);
    receiveGoods({
      orderId: order.order.id,
      expectedVersion: order.order.version,
      locationId: needsLocation ? locationId : null,
      supplierNote,
      lines: toReceive,
    })
      .then((after) => {
        Alert.alert(
          t('mobile.receive.title'),
          t('mobile.receive.recorded', { status: t(`purchasing.status.${after.order.status}`) }),
        );
        onChanged();
      })
      .catch((error: unknown) => {
        Alert.alert(t('mobile.receive.failed'), onlineFailureMessage(t, error));
      })
      .finally(() => setBusy(false));
  };

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{`${order.order.reference} · ${order.order.supplier.name}`}</Heading>
      <Badge label={t(`purchasing.status.${order.order.status}`)} tone="muted" />

      <Button
        label={t('mobile.receive.scan')}
        onPress={() => {
          setNotice(null);
          setScanning(true);
        }}
        busy={looking}
      />
      <Body muted>{t('mobile.receive.scanHint')}</Body>
      {notice === null ? null : (
        <View
          accessibilityRole="alert"
          style={[
            styles.notice,
            notice.tone === 'ok'
              ? { backgroundColor: theme.accentSubtle, borderColor: theme.accent }
              : { backgroundColor: theme.dangerSubtle, borderColor: theme.danger },
          ]}
        >
          <Text style={[styles.noticeText, { color: theme.text }]}>{notice.text}</Text>
        </View>
      )}

      <Section title={t('mobile.receive.lines')}>
        {lines.map((line) => {
          const left = outstanding(line);
          const now = counted(tally, line.id);
          return (
            <View
              key={line.id}
              style={[styles.line, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.title, { color: theme.text }]}>{line.item.name}</Text>
              <Text style={[styles.muted, { color: theme.textMuted }]}>
                {line.item.sku}
                {line.description === line.item.name ? '' : ` · ${line.description}`}
              </Text>
              <Text style={[styles.muted, { color: theme.text }]}>
                {t('mobile.receive.ordered', {
                  quantity: quantity(line.quantityOrdered, line.item.unit),
                })}{' '}
                ·{' '}
                {t('mobile.receive.received', {
                  quantity: quantity(line.quantityReceived, line.item.unit),
                })}
              </Text>
              {left === '0' ? (
                <Badge label={t('mobile.receive.full')} tone="muted" />
              ) : (
                <>
                  <Text style={[styles.counted, { color: theme.text }]}>
                    {t('mobile.receive.counted', { quantity: quantity(now, line.item.unit) })} ·{' '}
                    {t('mobile.receive.left', { quantity: quantity(left, line.item.unit) })}
                  </Text>
                  <Field
                    label={t('mobile.receive.type', { unit: unit(line.item.unit) })}
                    value={drafts[line.id] ?? (now === '0' ? '' : now)}
                    onChangeText={(text) => typed(line.id, text)}
                    keyboardType="decimal-pad"
                    error={errors[line.id]}
                  />
                </>
              )}
            </View>
          );
        })}
      </Section>

      {needsLocation ? (
        <Section title={t('mobile.receive.location')}>
          <Body muted>{t('mobile.receive.chooseLocation')}</Body>
          {warehouses.state.status !== 'ready' ? (
            <OnlineStatus state={warehouses.state} onRetry={warehouses.reload} />
          ) : (
            <View style={styles.choices}>
              {warehouses.state.data.map((location) => {
                const chosen = locationId === location.id;
                return (
                  <Pressable
                    key={location.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosen }}
                    onPress={() => setLocationId(location.id)}
                    style={[
                      styles.choice,
                      {
                        borderColor: chosen ? theme.accent : theme.border,
                        backgroundColor: chosen ? theme.accent : theme.surface,
                      },
                    ]}
                  >
                    <Text
                      style={{ color: chosen ? theme.onAccent : theme.text, fontWeight: '600' }}
                    >
                      {location.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Section>
      ) : (
        <Body muted>
          {t('mobile.receive.deliverTo', { location: order.order.deliveryLocation?.name ?? '' })}
        </Body>
      )}

      <Field
        label={t('mobile.receive.supplierNote')}
        value={supplierNote}
        onChangeText={setSupplierNote}
        maxLength={200}
      />
      <Button label={t('mobile.receive.record')} onPress={record} busy={busy} />
      <Button
        label={t('mobile.receive.clear')}
        variant="secondary"
        onPress={() => {
          setTally({});
          setDrafts({});
          setErrors({});
          setNotice(null);
        }}
        disabled={busy}
      />

      {scanning ? <BarcodeScanner onScanned={scanned} onCancel={() => setScanning(false)} /> : null}
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  notice: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  noticeText: { fontSize: 14, textAlign: 'auto' },
  line: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  muted: { fontSize: 14, textAlign: 'auto' },
  counted: { fontSize: 14, fontWeight: '600', textAlign: 'auto' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  choice: {
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
