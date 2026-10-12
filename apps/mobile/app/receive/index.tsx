import { useTranslation } from '@integr8/i18n';
import { router } from 'expo-router';
import { OnlineStatus } from '~/components/online';
import { BackButton, Body, EmptyState, Heading, Row, ScrollScreen, Section } from '~/components/ui';
import { formatMoney } from '~/lib/format';
import { fetchReceivableOrders } from '~/local/online';
import { useOnlineRequest } from '~/local/use-online';

/**
 * Receiving goods at the store (ADR-0012): the approved and partly received
 * purchase orders goods can still arrive against. Online only — with no
 * connection the screen says so. Opening one counts what arrived.
 */
export default function ReceiveOrdersScreen() {
  const { t, i18n } = useTranslation();
  const { state, reload } = useOnlineRequest('receivable-orders', fetchReceivableOrders);
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' }).format(
      new Date(`${value}T12:00:00Z`),
    );

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.receive.title')}</Heading>
      <Body muted>{t('mobile.receive.intro')}</Body>
      {state.status !== 'ready' ? (
        <OnlineStatus state={state} onRetry={reload} />
      ) : state.data.length === 0 ? (
        <EmptyState title={t('mobile.receive.none')} body="" />
      ) : (
        <Section title={t('mobile.receive.orders')}>
          {state.data.map((order) => (
            <Row
              key={order.id}
              title={`${order.reference} · ${order.supplier.name}`}
              lines={[
                order.expectedDate === null
                  ? ''
                  : t('mobile.receive.expected', { date: date(order.expectedDate) }),
                order.totals === null
                  ? ''
                  : formatMoney(order.totals.total, order.currencyCode, i18n.language),
              ]}
              tag={{ label: t(`purchasing.status.${order.status}`), tone: 'muted' }}
              onPress={() => router.push({ pathname: '/receive/[id]', params: { id: order.id } })}
            />
          ))}
        </Section>
      )}
    </ScrollScreen>
  );
}
