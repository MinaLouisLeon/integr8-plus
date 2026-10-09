import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * How a screen talks to the frame around it.
 *
 * The top bar shows a title and, on a nested route, a way back. Both default
 * from the route and the shared menu model — "Work orders", back to "Work
 * orders" — which is right for a list and wrong for a record: a work order's
 * screen should say the work order's reference. So a screen may set the title
 * (and the back link) with `useShellChrome`, and the setting is lifted again
 * when the screen unmounts, so the next route starts from its own defaults.
 */

export interface BackLink {
  to: string;
  label: string;
}

export interface ShellChromeOverride {
  /** The title the top bar shows instead of the section's. */
  title?: string | undefined;
  /** The way back; `null` hides the default one, `undefined` keeps it. */
  backTo?: BackLink | null | undefined;
}

interface ShellChromeState {
  override: ShellChromeOverride | null;
  setOverride: (next: ShellChromeOverride | null) => void;
}

const ShellChromeContext = createContext<ShellChromeState | null>(null);

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<ShellChromeOverride | null>(null);
  const value = useMemo(() => ({ override, setOverride }), [override]);
  return <ShellChromeContext.Provider value={value}>{children}</ShellChromeContext.Provider>;
}

/**
 * Sets the top bar's title and back link while the calling screen is mounted.
 * Safe to call outside the frame (in a test, say): it then does nothing.
 */
export function useShellChrome({ title, backTo }: ShellChromeOverride): void {
  const state = useContext(ShellChromeContext);
  const setOverride = state?.setOverride;
  const backToKey = backTo === undefined ? undefined : backTo === null ? null : backTo.to;
  const backLabel = backTo === undefined || backTo === null ? undefined : backTo.label;

  useEffect(() => {
    if (setOverride === undefined) {
      return;
    }
    setOverride({
      title,
      backTo:
        backToKey === undefined
          ? undefined
          : backToKey === null
            ? null
            : { to: backToKey, label: backLabel ?? '' },
    });
    return () => {
      setOverride(null);
    };
  }, [setOverride, title, backToKey, backLabel]);
}

/** What the screen on show has asked for, if anything. For the frame. */
export function useShellChromeOverride(): ShellChromeOverride | null {
  return useContext(ShellChromeContext)?.override ?? null;
}
