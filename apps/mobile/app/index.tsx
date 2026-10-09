import { router } from 'expo-router';
import { useEffect } from 'react';
import { Screen } from '~/components/ui';
import { COMPANY } from '~/lib/company';
import { session } from '~/lib/session';
import { localData } from '~/local/local-data';
import { resumeHref, savedRoute } from '~/local/resume';

/**
 * Decides where to send somebody on launch.
 *
 * "Signed in" includes a device holding a live offline grant whose refresh
 * token has lapsed. An engineer a week into a job with no signal still has to
 * get in — that is the entire point of the grant, and forgetting it here would
 * quietly undo it.
 *
 * Signed in, they go back to the screen they were on when the app was last
 * closed (P14), with their jobs underneath it, so Back still leads home.
 *
 * Signed out, a company's own app opens on its website (`/welcome`); the
 * generic app goes straight to sign-in, as it always has.
 */
export default function IndexScreen() {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const allowed = await session().isSignedIn();
      if (cancelled) {
        return;
      }
      if (!allowed) {
        router.replace(COMPANY === undefined ? '/sign-in' : '/welcome');
        return;
      }
      const db = await localData.open();
      const saved = db === undefined ? undefined : await savedRoute(db).catch(() => undefined);
      if (cancelled) {
        return;
      }
      router.replace('/home');
      if (saved !== undefined) {
        router.push(resumeHref(saved));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Reading the keychain takes a moment and involves no network, so there is
  // nothing to show a spinner for.
  return <Screen>{null}</Screen>;
}
