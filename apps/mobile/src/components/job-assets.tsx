import { useTranslation } from '@integr8/i18n';
import { assetsAtSite, assetsEnabled, assetsOfJob, type LocalAsset } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { linkAsset } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';
import type { WorkOrderDetail } from '@integr8/offline';
import { Badge, Body, Button, LocalReadError, Section, useTheme } from './ui';
import { refusalMessage } from '~/lib/refusals';

/**
 * The assets a job is for, on the phone (CRM/ERP plan, phase E3; ADR-0008):
 * open one to read its whole history, scan a tag to find one, link one of
 * the site's assets, or register one found on site. Shown only when the
 * company has assets for this person.
 */
export function JobAssets({ detail, closed }: { detail: WorkOrderDetail; closed: boolean }) {
  const { t } = useTranslation();
  const jobId = detail.workOrder.id;
  const siteId = detail.site.id;
  const state = useLocalQuery(
    `job-assets:${jobId}`,
    ['assets', 'asset_links', 'meta'],
    async (sql) => ({
      enabled: await assetsEnabled(sql),
      linked: await assetsOfJob(sql, jobId),
      atSite: await assetsAtSite(sql, siteId),
    }),
  );
  const [choosing, setChoosing] = useState(false);

  if (state.status === 'error') {
    return <LocalReadError />;
  }
  if (state.status !== 'ready' || !state.data.enabled) {
    return null;
  }
  const { linked, atSite } = state.data;
  const linkedIds = new Set(linked.map((asset) => asset.data.asset.id));
  const others = atSite.filter(
    (asset) => !linkedIds.has(asset.data.asset.id) && asset.data.asset.status !== 'retired',
  );
  const open = (asset: LocalAsset) =>
    router.push({
      pathname: '/assets/[id]',
      params: { id: asset.data.asset.id, workOrderId: jobId },
    });

  return (
    <Section title={t('mobile.assets.onJob')}>
      {linked.length === 0 ? <Body muted>{t('mobile.assets.noneOnJob')}</Body> : null}
      {linked.map((asset) => (
        <AssetRow key={asset.data.asset.id} asset={asset} onPress={() => open(asset)} />
      ))}
      {closed ? null : (
        <View style={styles.actions}>
          <Button
            label={t('mobile.assets.scan')}
            onPress={() =>
              router.push({ pathname: '/assets/scan', params: { workOrderId: jobId } })
            }
          />
          {others.length > 0 ? (
            <Button
              label={t('mobile.assets.linkHere')}
              variant="secondary"
              onPress={() => setChoosing((current) => !current)}
            />
          ) : null}
          <Button
            label={t('mobile.assets.register')}
            variant="secondary"
            onPress={() => router.push({ pathname: '/assets/new', params: { workOrderId: jobId } })}
          />
        </View>
      )}
      {choosing && !closed
        ? others.map((asset) => (
            <AssetRow
              key={asset.data.asset.id}
              asset={asset}
              onPress={() => {
                linkAsset({ workOrderId: jobId, assetId: asset.data.asset.id })
                  .then(() => setChoosing(false))
                  .catch((error: unknown) =>
                    Alert.alert(t('mobile.assets.linkFailed'), refusalMessage(t, error, '')),
                  );
              }}
            />
          ))
        : null}
    </Section>
  );
}

/**
 * One asset as a card: number, name, condition and where it is. Tappable
 * with `onPress`; without it, a plain card.
 */
export function AssetRow({ asset, onPress }: { asset: LocalAsset; onPress?: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data } = asset;
  const reference =
    data.asset.reference === '' ? t('mobile.assets.notYetNumbered') : data.asset.reference;
  return (
    <Pressable
      {...(onPress === undefined ? { disabled: true } : { accessibilityRole: 'button', onPress })}
      style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}
    >
      <Text style={[styles.title, { color: theme.text }]}>
        {reference} · {data.asset.name}
      </Text>
      <View style={styles.badges}>
        {data.asset.condition === null ? null : (
          <Badge
            label={t(`assets.condition.${data.asset.condition}`)}
            tone={
              data.asset.condition === 'poor' || data.asset.condition === 'unusable'
                ? 'danger'
                : 'muted'
            }
          />
        )}
        {data.asset.status === 'active' ? null : (
          <Badge label={t(`assets.status.${data.asset.status}`)} tone="danger" />
        )}
        {data.asset.warranty === 'expiring' || data.asset.warranty === 'expired' ? (
          <Badge label={t(`assets.warranty.${data.asset.warranty}`)} tone="accent" />
        ) : null}
        {asset.local ? <Badge label={t('mobile.assets.notSent')} tone="accent" /> : null}
      </View>
      {data.asset.locationNote === null ? null : <Body muted>{data.asset.locationNote}</Body>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  row: { borderWidth: 1, borderRadius: radii.lg, padding: spacing[3], gap: spacing[1] },
  title: { fontSize: 16, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[1] },
});
