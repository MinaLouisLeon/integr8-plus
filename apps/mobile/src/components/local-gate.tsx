import { useTranslation } from '@integr8/i18n';
import { useEffect, type ReactNode } from 'react';
import { localData } from '~/local/local-data';
import { useLocalStatus } from '~/local/react';
import { Body, Heading, Screen } from './ui';

/**
 * Renders its screen once the phone's database is open.
 *
 * Opening is local — a key from the keychain and a file on disk — so while it
 * happens the screen is simply blank for a moment: no spinner, because nothing
 * is being fetched. If the database cannot be opened, this says why and that
 * nothing was deleted, which is the one thing an engineer needs to know before
 * doing anything drastic like signing out.
 */
export function LocalGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useLocalStatus();

  useEffect(() => {
    if (status.phase === 'closed') {
      void localData.open();
    }
  }, [status.phase]);

  if (status.phase === 'failed') {
    return (
      <Screen>
        <Heading>{t('mobile.unavailable.title')}</Heading>
        <Body>{t(`mobile.unavailable.${status.reason}`)}</Body>
      </Screen>
    );
  }

  return status.phase === 'open' ? children : <Screen>{null}</Screen>;
}
