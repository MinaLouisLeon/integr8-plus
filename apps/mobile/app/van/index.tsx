import { useTranslation } from '@integr8/i18n';
import { van, vanStock } from '@integr8/offline';
import { router } from 'expo-router';
import { useState } from 'react';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  NotReadyScreen,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { VanStockItem } from '~/components/van-stock-row';
import { formatWhen } from '~/lib/format';
import { useLocalQuery } from '~/local/react';

/**
 * The engineer's van as the office last had it (ADR-0012), offline: each
 * item with its picture, what is on hand, reserved for customers' orders and
 * available, less this phone's own unsent uses. Refilling it is online only,
 * and is one tap from here.
 */
export default function VanScreen() {
  return (
    <LocalGate>
      <Van />
    </LocalGate>
  );
}

function Van() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const state = useLocalQuery(
    'van',
    ['meta', 'van_stock', 'outbox', 'item_images'],
    async (sql) => ({ van: await van(sql), stock: await vanStock(sql) }),
  );
  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  const { stock } = state.data;
  // A phone last synced before the van was kept on its own knows it from its stock.
  const myVan = state.data.van === undefined ? stock[0]?.location : state.data.van;
  const words = search.trim().toLowerCase();
  const shown = stock.filter(
    (row) =>
      words === '' ||
      row.item.name.toLowerCase().includes(words) ||
      row.item.sku.toLowerCase().includes(words),
  );

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>
        {myVan === undefined || myVan === null ? t('mobile.van.title') : myVan.name}
      </Heading>
      {myVan === undefined ? (
        <Body muted>{t('mobile.van.notYet')}</Body>
      ) : myVan === null ? (
        <EmptyState title={t('mobile.van.none')} body={t('mobile.refill.noVan')} />
      ) : (
        <>
          <Button label={t('mobile.van.refill')} onPress={() => router.push('/van/refill')} />
          {stock.length === 0 ? (
            <EmptyState title={myVan.name} body={t('mobile.van.empty')} />
          ) : (
            <Section title={t('mobile.van.title')}>
              <Body muted>{t('mobile.van.availableHint')}</Body>
              <Field
                label={t('mobile.parts.search')}
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
              />
              {shown.map((row) => (
                <VanStockItem key={row.item.id} row={row} />
              ))}
              <Body muted>
                {t('mobile.parts.asOf', { when: formatWhen(stock[0]!.updatedAt, i18n.language) })}
              </Body>
            </Section>
          )}
        </>
      )}
    </ScrollScreen>
  );
}
