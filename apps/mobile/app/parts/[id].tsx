import { useTranslation } from '@integr8/i18n';
import { job, LocalChangeError, vanStock, type VanStockRow } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  NotReadyScreen,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { formatWhen } from '~/lib/format';
import { recordPart } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';

/**
 * Using a part on a job, from the phone (CRM/ERP plan, phase E2; ADR-0005).
 *
 * The picker is the engineer's van as the office last had it, offline, with
 * this phone's own unsent uses taken off — a forecast, said to be one. The use
 * is recorded on the phone and sent with the job; the server decides whether
 * the van held enough and flags it for the office when it did not.
 */
export default function PartsScreen() {
  return (
    <LocalGate>
      <Parts />
    </LocalGate>
  );
}

function Parts() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(
    `parts:${id}`,
    ['work_orders', 'van_stock', 'outbox'],
    async (sql) => ({ job: await job(sql, id), stock: await vanStock(sql) }),
  );
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<VanStockRow | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  const back = (
    <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
  );
  if (state.data.job === undefined) {
    return (
      <ScrollScreen>
        {back}
        <Body>{t('mobile.job.notOnPhone')}</Body>
      </ScrollScreen>
    );
  }
  const { detail } = state.data.job;
  const { stock } = state.data;
  const format = (value: string, unit: string) =>
    `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 }).format(
      value as unknown as number,
    )} ${t(`inventory.unit.${unit}` as 'inventory.unit.each')}`;
  const words = search.trim().toLowerCase();
  const shown = stock.filter(
    (row) =>
      words === '' ||
      row.item.name.toLowerCase().includes(words) ||
      row.item.sku.toLowerCase().includes(words),
  );
  const valid = /^\d{1,16}(\.\d{1,4})?$/u.test(quantity.trim()) && /[1-9]/u.test(quantity);

  const record = async () => {
    if (chosen === null || !valid) {
      return;
    }
    setBusy(true);
    try {
      await recordPart({
        workOrderId: detail.workOrder.id,
        itemId: chosen.item.id,
        quantity: quantity.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      router.back();
    } catch (error) {
      Alert.alert(
        t('mobile.parts.use'),
        error instanceof LocalChangeError
          ? error.code === 'quantity_invalid'
            ? t('mobile.parts.invalidQuantity')
            : error.code === 'item_not_in_van'
              ? t('mobile.parts.notInVan')
              : error.message
          : t('mobile.work.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollScreen>
      {back}
      <Heading>{t('mobile.parts.use')}</Heading>
      <Body muted>
        {detail.workOrder.referenceLabel} · {detail.workOrder.title}
      </Body>

      {detail.van === null ? (
        <EmptyState title={t('mobile.parts.noVan')} body="" />
      ) : stock.length === 0 ? (
        <EmptyState title={detail.van.name} body={t('mobile.parts.vanEmpty')} />
      ) : chosen === null ? (
        <Section title={t('mobile.parts.pick')}>
          <TextInput
            accessibilityLabel={t('mobile.parts.search')}
            placeholder={t('mobile.parts.search')}
            placeholderTextColor={theme.textMuted}
            value={search}
            onChangeText={setSearch}
            style={[
              styles.search,
              { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text },
            ]}
          />
          {shown.map((row) => (
            <Pressable
              key={row.item.id}
              accessibilityRole="button"
              onPress={() => setChosen(row)}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.rowTitle, { color: theme.text }]}>{row.item.name}</Text>
              <Text style={[styles.rowLine, { color: theme.textMuted }]}>{row.item.sku}</Text>
              <Text style={[styles.rowLine, { color: theme.text }]}>
                {t('mobile.parts.forecast', { quantity: format(row.forecast, row.item.unit) })}
              </Text>
            </Pressable>
          ))}
          <Body muted>
            {t('mobile.parts.asOf', {
              when: formatWhen(stock[0]!.updatedAt, i18n.language),
            })}
          </Body>
        </Section>
      ) : (
        <Section title={chosen.item.name}>
          <Body muted>
            {t('mobile.parts.inVan', { quantity: format(chosen.onHand, chosen.item.unit) })} ·{' '}
            {t('mobile.parts.forecast', { quantity: format(chosen.forecast, chosen.item.unit) })}
          </Body>
          <Field
            label={`${t('mobile.parts.quantity')} (${t(`inventory.unit.${chosen.item.unit}` as 'inventory.unit.each')})`}
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="decimal-pad"
            {...(valid ? {} : { error: t('mobile.parts.invalidQuantity') })}
          />
          <Field label={t('mobile.parts.note')} value={note} onChangeText={setNote} />
          <View style={styles.actions}>
            <Button
              label={t('mobile.back')}
              variant="secondary"
              onPress={() => setChosen(null)}
              disabled={busy}
            />
            <Button
              label={t('mobile.parts.record')}
              onPress={() => void record()}
              busy={busy}
              disabled={!valid}
            />
          </View>
        </Section>
      )}
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  search: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 16,
    textAlign: 'auto',
  },
  row: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  rowTitle: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  rowLine: { fontSize: 14, textAlign: 'auto' },
  actions: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
});
