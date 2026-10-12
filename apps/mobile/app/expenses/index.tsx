import { useTranslation } from '@integr8/i18n';
import {
  discardChange,
  expensesEnabled,
  type LocalExpenseClaim,
  unsentExpenseClaims,
} from '@integr8/offline';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Body,
  Button,
  EmptyState,
  Heading,
  LocalReadError,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { formatMoney } from '~/lib/format';
import { choosePhotos, takePhoto } from '~/forms/capture';
import { addReceipt, fetchMyClaims } from '~/local/expense-actions';
import { localData } from '~/local/local-data';
import { useLocalQuery, useSyncActivity } from '~/local/react';
import { refusalMessage, syncRefusalMessage } from '~/lib/refusals';

type ServerClaim = Awaited<ReturnType<typeof fetchMyClaims>>[number];

/**
 * One's own expense claims on the phone (ADR-0010): those made here and not
 * yet all on the server first — read from the phone, so they show without
 * signal — then the recent ones as the server has them, when it can be asked.
 */
export default function ExpensesScreen() {
  return (
    <LocalGate>
      <Expenses />
    </LocalGate>
  );
}

function Expenses() {
  const { t, i18n } = useTranslation();
  const state = useLocalQuery('expenses', ['outbox', 'meta'], async (sql) => ({
    enabled: await expensesEnabled(sql),
    unsent: await unsentExpenseClaims(sql),
  }));
  const activity = useSyncActivity();
  const [server, setServer] = useState<
    { status: 'loading' } | { status: 'ready'; items: ServerClaim[] } | { status: 'offline' }
  >({ status: 'loading' });

  const unsentCount = state.status === 'ready' ? state.data.unsent.length : 0;
  const load = useCallback(() => {
    fetchMyClaims()
      .then((items) => setServer({ status: 'ready', items }))
      .catch(() =>
        setServer((current) => (current.status === 'ready' ? current : { status: 'offline' })),
      );
  }, []);
  // Asked again whenever a claim of this phone's finishes arriving, and after each sync.
  useEffect(() => {
    if (activity.phase === 'idle') {
      load();
    }
  }, [load, unsentCount, activity.phase]);

  if (state.status === 'error') {
    return (
      <ScrollScreen>
        <BackButton />
        <LocalReadError />
      </ScrollScreen>
    );
  }
  if (state.status !== 'ready') {
    return (
      <ScrollScreen>
        <BackButton />
      </ScrollScreen>
    );
  }

  const money = (amount: string, currency: string | null) =>
    formatMoney(amount, currency, i18n.language);
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' }).format(
      new Date(`${value}T12:00:00Z`),
    );

  /** Another receipt photo for a claim still on its way. */
  const addPhoto = (claim: LocalExpenseClaim) => {
    const add = (source: 'camera' | 'library') =>
      void (source === 'camera' ? takePhoto() : choosePhotos(1))
        .then(async (captured) => {
          if (captured.outcome !== 'captured') {
            return;
          }
          for (const file of captured.files) {
            await addReceipt(
              claim.claimId,
              file,
              t('mobile.expenses.receiptTitle', { number: claim.receipts.total + 1 }),
            );
          }
        })
        .catch((error: unknown) =>
          Alert.alert(t('mobile.expenses.failed'), refusalMessage(t, error, '')),
        );
    Alert.alert(t('mobile.expenses.addReceipt'), '', [
      { text: t('mobile.expenses.takePhoto'), onPress: () => add('camera') },
      { text: t('mobile.expenses.choosePhoto'), onPress: () => add('library') },
      { text: t('expenses.cancel'), style: 'cancel' },
    ]);
  };

  const drop = (claim: LocalExpenseClaim) => {
    Alert.alert(t('mobile.expenses.dropTitle'), t('mobile.expenses.dropBody'), [
      { text: t('mobile.expenses.keep'), style: 'cancel' },
      {
        text: t('mobile.expenses.drop'),
        style: 'destructive',
        onPress: () => {
          const context = localData.changeContext();
          if (context !== undefined) {
            void discardChange(context, claim.mutationId);
          }
        },
      },
    ]);
  };

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.expenses.title')}</Heading>
      <Body muted>{t('mobile.expenses.intro')}</Body>
      {state.data.enabled ? (
        <Button label={t('mobile.expenses.claim')} onPress={() => router.push('/expenses/new')} />
      ) : (
        <Body muted>{t('mobile.expenses.notEnabled')}</Body>
      )}

      {state.data.unsent.length === 0 ? null : (
        <Section title={t('mobile.expenses.onThisPhone')}>
          {state.data.unsent.map((claim) => (
            <Row
              key={claim.claimId}
              title={`${money(claim.amount, null)} · ${claim.categoryName}`}
              lines={[
                claim.description,
                t('mobile.expenses.spentOn', { date: date(claim.spentOn) }),
                claim.state === 'failed'
                  ? t('mobile.expenses.refused', {
                      message: syncRefusalMessage(t, claim.lastError),
                    })
                  : t('mobile.expenses.tapToAdd'),
                claim.receipts.total === 0
                  ? t('mobile.expenses.noReceipts')
                  : t('mobile.expenses.receiptsWaiting', {
                      count: claim.receipts.total,
                      waiting: claim.receipts.unsent,
                    }),
              ]}
              tag={
                claim.state === 'failed'
                  ? { label: t('mobile.expenses.state.failed'), tone: 'danger' }
                  : {
                      label: t(
                        claim.state === 'sent'
                          ? 'mobile.expenses.state.sent'
                          : 'mobile.expenses.state.pending',
                      ),
                      tone: 'muted',
                    }
              }
              onPress={() => (claim.state === 'failed' ? drop(claim) : addPhoto(claim))}
            />
          ))}
        </Section>
      )}

      <Section title={t('mobile.expenses.recent')}>
        {server.status === 'loading' ? (
          <Body muted>{t('common.loading')}</Body>
        ) : server.status === 'offline' ? (
          <Body muted>{t('mobile.expenses.offline')}</Body>
        ) : server.items.length === 0 ? (
          <EmptyState title={t('mobile.expenses.none')} body="" />
        ) : (
          server.items.map((claim) => (
            <Row
              key={claim.id}
              title={`${claim.reference} · ${money(claim.amount, claim.currency)}`}
              lines={[
                `${claim.category.name} · ${t('mobile.expenses.spentOn', { date: date(claim.spentOn) })}`,
                claim.description,
                claim.status === 'rejected' && claim.rejectReason !== null
                  ? t('mobile.expenses.rejectedBecause', { reason: claim.rejectReason })
                  : '',
              ]}
              tag={{
                label: t(`expenses.status.${claim.status}`),
                tone: claim.status === 'rejected' ? 'danger' : 'muted',
              }}
            />
          ))
        )}
      </Section>
    </ScrollScreen>
  );
}
