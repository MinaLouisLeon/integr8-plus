import { useEffect, useState } from 'react';

/** The time, updated every so often: for "clocked in 2 h 05 min" that keeps counting. */
export function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
