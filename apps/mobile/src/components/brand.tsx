import { identity } from '@integr8/offline';
import { brandAccent, type BrandAccent } from '@integr8/tokens';
import { createContext, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { useLocalQuery } from '~/local/react';

/**
 * The company's brand on the phone.
 *
 * Read from the phone's own tables, where the last download left the company's
 * name and colour (`identity`), so the app wears the brand in a basement with
 * no signal exactly as it does in the office. `useTheme` merges the accent
 * from here; a screen that wants the name asks for it.
 */

export interface Brand {
  name: string;
  logoMediaId: string | null;
  /** Null when the company has no colour, or nothing has been downloaded yet. */
  accent: BrandAccent | null;
}

const NONE: Brand = { name: '', logoMediaId: null, accent: null };

const BrandContext = createContext<Brand>(NONE);

export function BrandProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const me = useLocalQuery('identity', ['meta'], identity);
  const company = me.status === 'ready' ? me.data?.company : undefined;

  const brand: Brand =
    company === undefined
      ? NONE
      : {
          name: company.name,
          logoMediaId: company.logoMediaId,
          accent: company.brandColour === null ? null : brandAccent(company.brandColour, scheme),
        };

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
