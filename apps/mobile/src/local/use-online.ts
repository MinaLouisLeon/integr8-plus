import { useCallback, useEffect, useRef, useState } from 'react';
import { isOffline } from './online';

/**
 * A request an online-only screen makes (ADR-0012), with the three things it
 * can come to: the answer, no connection — the screen says it needs one, and
 * queues nothing — or a refusal or failure, said by its code.
 */
export type OnlineState<T> =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; data: T };

/**
 * Runs `load` now, again whenever `key` changes, and on `reload`. A reload
 * keeps showing what it had until the answer comes, so a list does not blink.
 */
export function useOnlineRequest<T>(
  key: string,
  load: () => Promise<T>,
): { state: OnlineState<T>; reload: () => void } {
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  const [state, setState] = useState<{ key: string; state: OnlineState<T> }>({
    key,
    state: { status: 'loading' },
  });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    latest
      .current()
      .then((data) => {
        if (current) {
          setState({ key, state: { status: 'ready', data } });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setState({
            key,
            state: isOffline(error) ? { status: 'offline' } : { status: 'failed', error },
          });
        }
      });
    return () => {
      current = false;
    };
  }, [key, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { state: state.key === key ? state.state : { status: 'loading' }, reload };
}
