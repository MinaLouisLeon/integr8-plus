import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { LoadingState, Screen } from '~/components/ui';
import { COMPANY } from '~/lib/company';
import { session } from '~/lib/session';
import { localData } from '~/local/local-data';
import { resumeHref, savedRoute } from '~/local/resume';

/**
 * Decides where to send somebody on launch.
 *
 * With no signal, the phone opens on its offline grant and nothing else
 * (P03): signed by our API, checked on the phone, and running for seven days
 * from the last time the phone reached us. An engineer a few days into a job
 * in a basement gets in, which is the whole point of the grant. A phone whose
 * grant has lapsed asks for a connection (`/reconnect`) rather than opening on
 * its refresh token, which lasts thirty days and proves nothing offline.
 *
 * Signed in, they go back to the screen they were on when the app was last
 * closed (P14), with their jobs underneath it, so Back still leads home.
 *
 * Signed out, a company's own app opens on its website (`/welcome`); the
 * generic app goes straight to sign-in, as it always has.
 */
export default function IndexScreen() {
  // Only shown when the grant has lapsed and the phone is asking the server.
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // The usual case is local and instant: a live grant in the keychain. A
      // session without one has to ask the server, which can take a moment.
      if ((await session().isSignedIn()) && !(await session().canWorkOffline())) {
        setAsking(true);
      }
      const decision = await session().openDecision();
      if (cancelled) {
        return;
      }
      if (decision === 'sign_in') {
        router.replace(COMPANY === undefined ? '/sign-in' : '/welcome');
        return;
      }
      if (decision === 'connect') {
        router.replace('/reconnect');
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

  return <Screen>{asking ? <LoadingState /> : null}</Screen>;
}
