import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { LoadingState, Screen } from '~/components/ui';
import { session } from '~/lib/session';

/**
 * Decides where to send somebody on launch.
 *
 * "Signed in" includes a device holding a live offline grant whose refresh
 * token has lapsed. An engineer a week into a job with no signal still has to
 * get in — that is the entire point of the grant, and forgetting it here would
 * quietly undo it.
 */
export default function IndexScreen() {
  const [destination, setDestination] = useState<'unknown' | '/sign-in' | '/home'>('unknown');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const allowed = await session().isSignedIn();
      if (!cancelled) {
        setDestination(allowed ? '/home' : '/sign-in');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (destination === 'unknown') {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  return <Redirect href={destination} />;
}
