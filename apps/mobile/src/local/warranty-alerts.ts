import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { markWarrantyAlerted, type WarrantyAlert, warrantyAlertsDue } from '@integr8/offline';
import * as Sentry from '@sentry/react-native';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { localData } from './local-data';
import { useLocalQuery } from './react';

/**
 * Warranty alerts on the phone (CRM/ERP plan, phase E3; ADR-0008): one local
 * notification per asset and expiry date, for the assets at the engineer's
 * sites whose warranty ends within the company's window. Nothing is sent from
 * the server; the phone works it out from what it synced, so it needs no
 * push project and no signal.
 *
 * An alert is recorded as given before it is shown: a crash in between costs
 * one notification, never a repeat of it. More than a few at once — the first
 * sync on a new phone — are folded into one.
 */

/** Tells `openFromNotification` (`push.ts`) this came from the phone, not the server. */
const WARRANTY_KIND = 'warranty';

const ONE_EACH_UP_TO = 3;

let announcing = false;

async function allowed(): Promise<boolean> {
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
  }
  return permission.granted;
}

async function announce(
  alerts: readonly WarrantyAlert[],
  describe: (alert: WarrantyAlert) => { title: string; body: string },
  summary: { title: string; body: string },
): Promise<void> {
  const status = localData.status();
  if (announcing || status.phase !== 'open' || !(await allowed())) {
    return;
  }
  announcing = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    await status.db.write(['meta'], (sql) => markWarrantyAlerted(sql, alerts, today));
    const trigger = Platform.OS === 'android' ? { channelId: 'jobs' } : null;
    if (alerts.length > ONE_EACH_UP_TO) {
      await Notifications.scheduleNotificationAsync({
        content: { ...summary, data: { kind: WARRANTY_KIND } },
        trigger,
      });
      return;
    }
    for (const alert of alerts) {
      await Notifications.scheduleNotificationAsync({
        content: { ...describe(alert), data: { kind: WARRANTY_KIND, assetId: alert.assetId } },
        trigger,
      });
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'warranty-alerts' } });
  } finally {
    announcing = false;
  }
}

/** Mounted once at the root: watches the phone's assets and announces what is due. */
export function WarrantyAlerts(): null {
  const { t, i18n } = useTranslation();
  const due = useLocalQuery('warranty-alerts', ['assets', 'meta'], warrantyAlertsDue);
  const alerts = due.status === 'ready' ? due.data : [];
  const key = alerts.map((alert) => `${alert.assetId}:${alert.warrantyExpiresOn}`).join(',');

  useEffect(() => {
    if (alerts.length === 0) {
      return;
    }
    void announce(
      alerts,
      (alert) => ({
        title: t('mobile.assets.warrantyTitle'),
        body: t('mobile.assets.warrantyBody', {
          asset: alert.reference === '' ? alert.name : `${alert.reference} · ${alert.name}`,
          site: alert.siteName,
          date: formatCalendarDate(alert.warrantyExpiresOn, { locale: i18n.language }),
        }),
      }),
      {
        title: t('mobile.assets.warrantyTitle'),
        body: t('mobile.assets.warrantySummary', { count: alerts.length }),
      },
    );
    // `key` names the alerts; the array itself is new on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
