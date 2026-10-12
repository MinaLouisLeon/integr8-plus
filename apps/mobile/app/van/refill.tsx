import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { vanStock } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import { onlineFailureMessage, OnlineStatus } from '~/components/online';
import {
  BackButton,
  Badge,
  Body,
  Button,
  Detail,
  EmptyState,
  Field,
  Heading,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { VanStockItem } from '~/components/van-stock-row';
import { formatQuantity, formatWhen } from '~/lib/format';
import {
  addItem,
  fromProposal,
  type RefillItem,
  type RefillLine,
  removeItem,
  requestLines,
  setQuantity,
} from '~/lib/refill-lines';
import {
  cancelVanRequest,
  createVanRequest,
  fetchVanProposal,
  fetchVanRequests,
  searchCatalogue,
  type VanRequest,
} from '~/local/online';
import { useLocalQuery } from '~/local/react';
import { useOnlineRequest } from '~/local/use-online';

/**
 * Asking the store to refill the van (ADR-0012). Online only, by the product
 * owner's decision: with no connection the screen says so and keeps nothing
 * to send later. It starts from what the van's reorder levels propose; the
 * engineer changes quantities, removes lines and adds items from the
 * catalogue or the van's own stock, then sends it. Their requests follow,
 * with what the store picked, and an open one can be withdrawn.
 */
export default function RefillScreen() {
  return (
    <LocalGate>
      <Refill />
    </LocalGate>
  );
}

const isNoVan = (error: unknown) => error instanceof ApiRequestError && error.code === 'no_van';

async function loadRefill() {
  const [proposal, requests] = await Promise.all([
    fetchVanProposal().catch((error: unknown) => {
      if (isNoVan(error)) {
        return null;
      }
      throw error;
    }),
    fetchVanRequests(),
  ]);
  return { proposal, requests };
}

function Refill() {
  const { t, i18n } = useTranslation();
  const { state, reload } = useOnlineRequest('refill', loadRefill);
  const stock = useLocalQuery('refill-van', ['van_stock', 'outbox', 'item_images'], vanStock);
  /** Null while the request is still the van's proposal as it came. */
  const [lines, setLines] = useState<RefillLine[] | null>(null);
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState<'van' | 'catalogue' | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const unit = (code: string) => t(`inventory.unit.${code}` as 'inventory.unit.each');
  const quantity = (value: string, code: string) =>
    formatQuantity(value, i18n.language, unit(code));

  if (state.status !== 'ready') {
    return (
      <ScrollScreen>
        <BackButton />
        <Heading>{t('mobile.refill.title')}</Heading>
        <Body muted>{t('mobile.refill.intro')}</Body>
        <OnlineStatus state={state} onRetry={reload} />
      </ScrollScreen>
    );
  }
  if (state.data.proposal === null) {
    return (
      <ScrollScreen>
        <BackButton />
        <Heading>{t('mobile.refill.title')}</Heading>
        <EmptyState title={t('mobile.van.none')} body={t('mobile.refill.noVan')} />
      </ScrollScreen>
    );
  }

  // The van's proposal is where the request starts, until the engineer changes it.
  const current = lines ?? fromProposal(state.data.proposal.lines);
  const check = requestLines(current);
  const invalid = new Set(!check.ok && check.reason === 'invalid_quantity' ? check.itemIds : []);

  const send = () => {
    setTried(true);
    if (!check.ok) {
      return;
    }
    setBusy(true);
    createVanRequest({ notes, lines: check.lines })
      .then(() => {
        Alert.alert(t('mobile.refill.title'), t('mobile.refill.sent'));
        setLines(null);
        setNotes('');
        setTried(false);
        setAdding(null);
        reload();
      })
      .catch((error: unknown) =>
        Alert.alert(
          t('mobile.refill.failed'),
          error instanceof ApiRequestError && error.code === 'item_repeated'
            ? t('mobile.refill.repeated')
            : isNoVan(error)
              ? t('mobile.refill.noVan')
              : onlineFailureMessage(t, error),
        ),
      )
      .finally(() => setBusy(false));
  };

  const add = (item: RefillItem) => setLines(addItem(current, item));

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.refill.title')}</Heading>
      <Body muted>{t('mobile.refill.intro')}</Body>

      <Section title={t('mobile.refill.proposal')}>
        <Body muted>
          {current.length === 0
            ? t('mobile.refill.proposalEmpty')
            : t('mobile.refill.proposalHint')}
        </Body>
        {current.map((line) => (
          <View key={line.item.id} style={{ gap: spacing[2] }}>
            <Row
              title={line.item.name}
              lines={[
                line.item.sku,
                line.proposed === undefined
                  ? ''
                  : t('mobile.refill.level', {
                      onHand: quantity(line.proposed.onHand, line.item.unit),
                      minimum: quantity(line.proposed.minimum, line.item.unit),
                    }),
                line.proposed === undefined || line.proposed.requested === '0'
                  ? ''
                  : t('mobile.refill.alreadyAsked', {
                      quantity: quantity(line.proposed.requested, line.item.unit),
                    }),
              ]}
            />
            <Field
              label={t('mobile.refill.quantityOf', {
                item: line.item.name,
                unit: unit(line.item.unit),
              })}
              value={line.quantity}
              onChangeText={(text) => setLines(setQuantity(current, line.item.id, text))}
              keyboardType="decimal-pad"
              error={
                tried && invalid.has(line.item.id) ? t('mobile.refill.invalidQuantity') : undefined
              }
            />
            <View style={{ alignItems: 'flex-start' }}>
              <Button
                label={t('mobile.refill.remove')}
                variant="secondary"
                onPress={() => setLines(removeItem(current, line.item.id))}
              />
            </View>
          </View>
        ))}
      </Section>

      <Section title={t('mobile.refill.add')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
          <Button
            label={t('mobile.refill.fromVan')}
            variant={adding === 'van' ? 'primary' : 'secondary'}
            onPress={() => setAdding(adding === 'van' ? null : 'van')}
          />
          <Button
            label={t('mobile.refill.fromCatalogue')}
            variant={adding === 'catalogue' ? 'primary' : 'secondary'}
            onPress={() => setAdding(adding === 'catalogue' ? null : 'catalogue')}
          />
        </View>
        {adding === 'van' && stock.status === 'ready'
          ? stock.data.map((row) =>
              current.some((line) => line.item.id === row.item.id) ? null : (
                <VanStockItem key={row.item.id} row={row} onPress={() => add(row.item)} />
              ),
            )
          : null}
        {adding === 'catalogue' ? (
          <CatalogueSearch onChoose={add} chosen={new Set(current.map((line) => line.item.id))} />
        ) : null}
      </Section>

      <Field
        label={t('mobile.refill.notes')}
        value={notes}
        onChangeText={setNotes}
        multiline
        maxLength={1000}
      />
      {tried && !check.ok && check.reason === 'empty' ? (
        <Body>{t('mobile.refill.nothingToSend')}</Body>
      ) : null}
      <Button label={t('mobile.refill.send')} onPress={send} busy={busy} />

      <Requests requests={state.data.requests} onChanged={reload} />
    </ScrollScreen>
  );
}

function CatalogueSearch({
  onChoose,
  chosen,
}: {
  onChoose: (item: RefillItem) => void;
  chosen: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const results = useOnlineRequest(`catalogue:${query}`, () =>
    query.length < 2 ? Promise.resolve([]) : searchCatalogue(query),
  );
  const search = () => setQuery(text.trim());

  return (
    <>
      <Field
        label={t('mobile.refill.search')}
        value={text}
        onChangeText={setText}
        onSubmitEditing={search}
        returnKeyType="search"
        autoCorrect={false}
      />
      <Button label={t('mobile.refill.search')} variant="secondary" onPress={search} />
      {query.length < 2 ? (
        <Body muted>{t('mobile.refill.searchHint')}</Body>
      ) : results.state.status !== 'ready' ? (
        <OnlineStatus state={results.state} onRetry={results.reload} />
      ) : results.state.data.length === 0 ? (
        <Body muted>{t('mobile.refill.noMatches')}</Body>
      ) : (
        results.state.data.map((item) => (
          <Row
            key={item.id}
            title={item.name}
            lines={[item.sku]}
            tag={
              chosen.has(item.id)
                ? { label: t('mobile.refill.onRequest'), tone: 'muted' }
                : undefined
            }
            onPress={
              chosen.has(item.id)
                ? undefined
                : () => onChoose({ id: item.id, sku: item.sku, name: item.name, unit: item.unit })
            }
          />
        ))
      )}
    </>
  );
}

function Requests({
  requests,
  onChanged,
}: {
  requests: readonly VanRequest[];
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const quantity = (value: string, unit: string) =>
    formatQuantity(value, i18n.language, t(`inventory.unit.${unit}` as 'inventory.unit.each'));

  const withdraw = (request: VanRequest) => {
    Alert.alert(t('mobile.refill.withdrawTitle'), t('mobile.refill.withdrawBody'), [
      { text: t('mobile.refill.keep'), style: 'cancel' },
      {
        text: t('mobile.refill.withdraw'),
        style: 'destructive',
        onPress: () => {
          cancelVanRequest(request.id, request.version)
            .then(onChanged)
            .catch((error: unknown) =>
              Alert.alert(t('mobile.refill.withdraw'), onlineFailureMessage(t, error)),
            );
        },
      },
    ]);
  };

  return (
    <Section title={t('mobile.refill.requests')}>
      {requests.length === 0 ? <Body muted>{t('mobile.refill.noRequests')}</Body> : null}
      {requests.map((request) => (
        <View key={request.id} style={{ gap: spacing[2] }}>
          <Detail
            label={t('mobile.refill.requestedAt', {
              when: formatWhen(request.requestedAt, i18n.language),
            })}
          >
            <View style={{ gap: spacing[1] }}>
              <Badge
                label={t(`mobile.refill.status.${request.status}`)}
                tone={request.status === 'open' ? 'accent' : 'muted'}
              />
              {request.pickedAt === null ? null : (
                <Body muted>
                  {t('mobile.refill.pickedAt', {
                    when: formatWhen(request.pickedAt, i18n.language),
                    location: request.from?.name ?? '',
                  })}
                </Body>
              )}
              {request.lines.map((line) => (
                <Body key={line.item.id}>
                  {line.picked === null
                    ? t('mobile.refill.asked', {
                        item: line.item.name,
                        requested: quantity(line.requested, line.item.unit),
                      })
                    : t('mobile.refill.picked', {
                        item: line.item.name,
                        requested: quantity(line.requested, line.item.unit),
                        picked: quantity(line.picked, line.item.unit),
                      })}
                </Body>
              ))}
              {request.notes === null ? null : <Body muted>{request.notes}</Body>}
            </View>
          </Detail>
          {request.can.cancel ? (
            <View style={{ alignItems: 'flex-start' }}>
              <Button
                label={t('mobile.refill.withdraw')}
                variant="secondary"
                onPress={() => withdraw(request)}
              />
            </View>
          ) : null}
        </View>
      ))}
    </Section>
  );
}
