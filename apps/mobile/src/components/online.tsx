import { type TFunction, useTranslation } from '@integr8/i18n';
import { refusalMessage } from '~/lib/refusals';
import { isOffline } from '~/local/online';
import type { OnlineState } from '~/local/use-online';
import { Button, EmptyState, ErrorState, LoadingState } from './ui';

/** Why an action on an online-only screen did not go: no connection, or the refusal by its code. */
export function onlineFailureMessage(t: TFunction, error: unknown): string {
  return isOffline(error)
    ? t('mobile.online.neededBody')
    : refusalMessage(t, error, t('mobile.online.failed'));
}

/**
 * What an online-only screen shows when it has no answer (ADR-0012): a clear
 * "needs a connection" with a way to try again — never a queue, never a
 * spinner standing in for a connection that is not there — or the refusal in
 * the reader's language, by its code.
 */
export function NeedsConnection({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <EmptyState title={t('mobile.online.needed')} body={t('mobile.online.neededBody')} />
      <Button label={t('mobile.online.retry')} variant="secondary" onPress={onRetry} />
    </>
  );
}

/** Loading, offline or failed; nothing once the answer is in. */
export function OnlineStatus<T>({
  state,
  onRetry,
}: {
  state: OnlineState<T>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  switch (state.status) {
    case 'loading':
      return <LoadingState />;
    case 'offline':
      return <NeedsConnection onRetry={onRetry} />;
    case 'failed':
      return (
        <ErrorState
          message={refusalMessage(t, state.error, t('mobile.online.failed'))}
          onRetry={onRetry}
        />
      );
    case 'ready':
      return null;
  }
}
