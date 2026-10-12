import { useTranslation } from '@integr8/i18n';
import { discardChange, type LocalPurchase, unsentPurchases } from '@integr8/offline';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import { choosePhotos, takePhoto } from '~/forms/capture';
import { formatMoney, formatQuantity } from '~/lib/format';
import { refusalMessage, syncRefusalMessage } from '~/lib/refusals';
import { addBoughtReceipt } from '~/local/job-actions';
import { localData } from '~/local/local-data';
import { fetchJobPurchases } from '~/local/online';
import { useLocalQuery } from '~/local/react';
import { useOnlineRequest } from '~/local/use-online';
import { Body, Button, LocalReadError, Row, Section } from './ui';

/**
 * Parts bought from a merchant for a job (ADR-0012). Those recorded on this
 * phone and not all sent yet come first, read from the phone so they show
 * without signal; then the job's purchases as the office has them, when the
 * phone can ask. A purchase is recorded offline, like a part used.
 */
export function JobPurchases({
  workOrderId,
  canRecord,
}: {
  workOrderId: string;
  canRecord: boolean;
}) {
  const { t, i18n } = useTranslation();
  const local = useLocalQuery(`purchases:${workOrderId}`, ['outbox'], (sql) =>
    unsentPurchases(sql, workOrderId),
  );
  const mine = local.status === 'ready' ? local.data : [];
  // Asked again whenever one of this phone's finishes arriving.
  const server = useOnlineRequest(`purchases:${workOrderId}:${String(mine.length)}`, () =>
    fetchJobPurchases(workOrderId),
  );
  const items = server.state.status === 'ready' ? server.state.data.items : [];
  const onPhone = new Set(mine.map((purchase) => purchase.purchaseId));
  const atOffice = items.filter((purchase) => !onPhone.has(purchase.id));

  if (!canRecord && mine.length === 0 && atOffice.length === 0) {
    return null;
  }

  const quantity = (value: string) => formatQuantity(value, i18n.language);
  const money = (value: string) => formatMoney(value, null, i18n.language);
  const priced = (count: string, price: string | null) =>
    price === null
      ? quantity(count)
      : t('mobile.bought.line', { quantity: quantity(count), price: money(price) });

  const addPhoto = (purchase: LocalPurchase) => {
    const add = (source: 'camera' | 'library') =>
      void (source === 'camera' ? takePhoto() : choosePhotos(1))
        .then(async (captured) => {
          if (captured.outcome !== 'captured') {
            return;
          }
          for (const file of captured.files) {
            await addBoughtReceipt(
              purchase.purchaseId,
              file,
              t('mobile.bought.receiptTitle', { number: purchase.receipts.total + 1 }),
            );
          }
        })
        .catch((error: unknown) =>
          Alert.alert(t('mobile.bought.failed'), refusalMessage(t, error, t('mobile.work.failed'))),
        );
    Alert.alert(t('mobile.bought.addReceipt'), '', [
      { text: t('mobile.expenses.takePhoto'), onPress: () => add('camera') },
      { text: t('mobile.expenses.choosePhoto'), onPress: () => add('library') },
      { text: t('expenses.cancel'), style: 'cancel' },
    ]);
  };

  const drop = (purchase: LocalPurchase) => {
    Alert.alert(t('mobile.bought.dropTitle'), t('mobile.bought.dropBody'), [
      { text: t('mobile.bought.keep'), style: 'cancel' },
      {
        text: t('mobile.bought.drop'),
        style: 'destructive',
        onPress: () => {
          const context = localData.changeContext();
          if (context !== undefined) {
            void discardChange(context, purchase.mutationId);
          }
        },
      },
    ]);
  };

  return (
    <Section title={t('mobile.bought.title')}>
      {local.status === 'error' ? <LocalReadError /> : null}
      {mine.map((purchase) => (
        <Row
          key={purchase.purchaseId}
          title={purchase.description}
          lines={[
            priced(purchase.quantity, purchase.unitPrice),
            purchase.merchant === null
              ? ''
              : t('mobile.bought.from', { merchant: purchase.merchant }),
            purchase.note ?? '',
            purchase.receipts.total === 0
              ? t('mobile.bought.noReceipt')
              : t('mobile.bought.receipts', {
                  count: purchase.receipts.total,
                  waiting: purchase.receipts.unsent,
                }),
            purchase.state === 'failed'
              ? t('mobile.bought.refused', { message: syncRefusalMessage(t, purchase.lastError) })
              : t('mobile.bought.tapToAdd'),
          ]}
          tag={
            purchase.state === 'failed'
              ? { label: t('mobile.bought.state.failed'), tone: 'danger' }
              : { label: t(`mobile.bought.state.${purchase.state}`), tone: 'muted' }
          }
          onPress={() => (purchase.state === 'failed' ? drop(purchase) : addPhoto(purchase))}
        />
      ))}
      {server.state.status === 'offline' ? (
        <Body muted>{t('mobile.bought.offline')}</Body>
      ) : server.state.status === 'ready' && atOffice.length === 0 && mine.length === 0 ? (
        <Body muted>{t('mobile.bought.none')}</Body>
      ) : null}
      {atOffice.map((purchase) => (
        <Row
          key={purchase.id}
          title={purchase.description}
          lines={[
            priced(purchase.quantity, purchase.unitPrice),
            purchase.merchant === null
              ? ''
              : t('mobile.bought.from', { merchant: purchase.merchant }),
            purchase.note ?? '',
            purchase.receipts.length === 0
              ? t('mobile.bought.noReceipt')
              : t('mobile.bought.receipts', { count: purchase.receipts.length, waiting: 0 }),
          ]}
          tag={
            purchase.cancelledAt === null
              ? undefined
              : { label: t('mobile.bought.takenOff'), tone: 'muted' }
          }
        />
      ))}
      {canRecord ? (
        <Button
          label={t('mobile.bought.add')}
          variant="secondary"
          onPress={() => router.push({ pathname: '/purchases/[id]', params: { id: workOrderId } })}
        />
      ) : null}
    </Section>
  );
}
