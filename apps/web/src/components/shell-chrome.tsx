'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * What the top bar says, and where its back link goes.
 *
 * The shell works a default out from the pathname and the navigation model: a
 * page under `/work-orders` is titled "Work orders" and goes back to the list.
 * A page that knows better — a job that has loaded its reference, a customer
 * its name — says so through `useShellChrome`, and the bar follows while the
 * page is mounted and forgets when it is not.
 */

export interface ShellChrome {
  /** Replaces the section title. */
  title?: string | undefined;
  /** Replaces the back link's target; `null` removes the link. */
  backHref?: string | null | undefined;
  /** Replaces the back link's label. */
  backLabel?: string | undefined;
}

interface ShellChromeState {
  override: ShellChrome | null;
  setOverride: (chrome: ShellChrome | null) => void;
}

const ShellChromeContext = createContext<ShellChromeState | null>(null);

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<ShellChrome | null>(null);
  const value = useMemo(() => ({ override, setOverride }), [override]);
  return <ShellChromeContext.Provider value={value}>{children}</ShellChromeContext.Provider>;
}

/** The current override, for the shell that draws the bar. */
export function useShellChromeOverride(): ShellChrome | null {
  return useContext(ShellChromeContext)?.override ?? null;
}

/**
 * Tells the top bar what this page is.
 *
 * Call it with the loaded record's name once it is known; until then the shell's
 * default stands. Outside a shell it does nothing, so a screen shared with a
 * page that has no top bar is unaffected.
 */
export function useShellChrome({ title, backHref, backLabel }: ShellChrome): void {
  const state = useContext(ShellChromeContext);
  const setOverride = state?.setOverride;

  useEffect(() => {
    if (setOverride === undefined) {
      return;
    }
    setOverride({ title, backHref, backLabel });
    return () => {
      setOverride(null);
    };
  }, [setOverride, title, backHref, backLabel]);
}
