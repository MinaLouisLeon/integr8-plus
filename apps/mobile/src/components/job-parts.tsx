import { useTranslation } from '@integr8/i18n';
import type { WorkOrderDetail } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalQuery } from '~/local/react';
import { Badge, Body, Button, LocalReadError, Section, useTheme } from './ui';

/**
 * The parts used on a job, from the phone (CRM/ERP plan, phase E2; ADR-0005).
 * A use recorded here shows at once and is sent with the job; the server
 * decides whether the van held enough, and a use it refused comes back
 * flagged for the office — nothing is taken from stock for it.
 */

type Job = WorkOrderDetail;

function unsentMaterialIds(sql: Parameters<Parameters<typeof useLocalQuery>[2]>[0]) {
  return sql
    .all<{ payload: string }>(
      `select payload from outbox where kind = 'work_order.material' and state <> 'done'`,
    )
    .then(
      (rows) =>
        new Set(rows.map((row) => (JSON.parse(row.payload) as { materialId: string }).materialId)),
    );
}

export function JobParts({ detail, closed }: { detail: Job; closed: boolean }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const unsent = useLocalQuery(`job-parts-unsent:${detail.workOrder.id}`, ['outbox'], (sql) =>
    unsentMaterialIds(sql),
  );
  const materials = detail.materials ?? [];
  const canRecord = detail.can.recordParts && !closed;
  if (materials.length === 0 && !canRecord) {
    return null;
  }
  if (unsent.status === 'error') {
    return <LocalReadError />;
  }
  const pending = unsent.status === 'ready' ? unsent.data : new Set<string>();
  const format = (value: string, unit: string) =>
    `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 }).format(
      value as unknown as number,
    )} ${t(`inventory.unit.${unit}` as 'inventory.unit.each')}`;

  return (
    <Section title={t('mobile.parts.title')}>
      {materials.length === 0 ? <Body muted>{t('mobile.parts.none')}</Body> : null}
      {materials.map((material) => (
        <View
          key={material.id}
          style={[styles.part, { borderColor: theme.border, backgroundColor: theme.surface }]}
        >
          <Text style={[styles.title, { color: theme.text }]}>
            {material.item.name} · {format(material.quantity, material.item.unit)}
          </Text>
          {material.note === null ? null : <Body muted>{material.note}</Body>}
          <View style={styles.badges}>
            {pending.has(material.id) ? (
              <Badge label={t('mobile.parts.pending')} tone="muted" />
            ) : (
              <Badge
                label={t(`mobile.parts.status.${material.status}`)}
                tone={material.status === 'conflict' ? 'danger' : 'muted'}
              />
            )}
          </View>
          {material.status === 'conflict' ? (
            <Body muted>{t('mobile.parts.conflictHelp')}</Body>
          ) : null}
        </View>
      ))}
      {canRecord ? (
        <Button
          label={t('mobile.parts.use')}
          variant="secondary"
          onPress={() =>
            router.push({ pathname: '/parts/[id]', params: { id: detail.workOrder.id } })
          }
        />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  part: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'auto' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
