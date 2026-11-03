import type { PhoneScreen } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { access, screenShown } from '@integr8/offline';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useLocalQuery } from '~/local/react';
import { LocalGate } from './local-gate';
import { BackButton, Body, Heading, Screen } from './ui';

/**
 * Renders a screen only while the company still shows it (0075).
 *
 * Integr8 can switch a tab off for a company, and the phone screen that
 * belongs to it goes with it: off the home screen, and — for a notification or
 * a link that still leads here — "not available" in its place. As last heard
 * from the server, like the rest of what the phone shows.
 */
export function ScreenGate({ screen, children }: { screen: PhoneScreen; children: ReactNode }) {
  return (
    <LocalGate>
      <Gate screen={screen}>{children}</Gate>
    </LocalGate>
  );
}

function Gate({ screen, children }: { screen: PhoneScreen; children: ReactNode }) {
  const { t } = useTranslation();
  const granted = useLocalQuery('access', ['meta'], access);

  if (granted.status !== 'ready') {
    return <Screen>{router.canGoBack() ? <BackButton /> : null}</Screen>;
  }
  if (!screenShown(granted.data, screen)) {
    return (
      <Screen>
        {router.canGoBack() ? <BackButton /> : null}
        <Heading>{t('nav.unavailable.title')}</Heading>
        <Body>{t('nav.unavailable.body')}</Body>
      </Screen>
    );
  }
  return children;
}
