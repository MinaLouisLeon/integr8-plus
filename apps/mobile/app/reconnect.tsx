import { useTranslation } from '@integr8/i18n';
import * as Network from 'expo-network';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Body, Button, Heading, Screen } from '~/components/ui';
import { COMPANY } from '~/lib/company';
import { session } from '~/lib/session';

/**
 * The phone's offline grant has lapsed and the API cannot be reached (P03).
 *
 * The phone works offline for seven days from the last time it reached us. A
 * lost phone in a drawer must stop opening at some point, and this is that
 * point; an engineer who simply has had no signal for a week needs one bar of
 * it, once. Their unsent work stays on the phone, encrypted, and is sent as
 * soon as they are back in.
 *
 * It tries again by itself when a connection appears, and on **Try again**.
 */
export default function ReconnectScreen() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);
  const trying = useRef(false);

  const retry = useCallback(async () => {
    if (trying.current) {
      return;
    }
    trying.current = true;
    setBusy(true);
    try {
      const decision = await session().openDecision();
      if (decision === 'open') {
        // The launch screen decides the rest: the database, the saved screen.
        router.replace('/');
      } else if (decision === 'sign_in') {
        router.replace(COMPANY === undefined ? '/sign-in' : '/welcome');
      } else {
        setStillOffline(true);
      }
    } finally {
      trying.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const listener = Network.addNetworkStateListener((state) => {
      if (state.isInternetReachable === true) {
        void retry();
      }
    });
    return () => listener.remove();
  }, [retry]);

  return (
    <Screen>
      <Heading>{t('mobile.reconnect.title')}</Heading>
      <Body>{t('mobile.reconnect.body')}</Body>
      {stillOffline ? <Body muted>{t('mobile.reconnect.stillOffline')}</Body> : null}
      <Button label={t('mobile.reconnect.retry')} busy={busy} onPress={() => void retry()} />
    </Screen>
  );
}
