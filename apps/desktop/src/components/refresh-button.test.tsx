import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { refreshAll, RefreshButton } from './refresh-button';

/**
 * The top bar's Refresh: what was fetched before a change made elsewhere is
 * fetched again without signing out.
 */

function render(locale: 'en' | 'ar'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <QueryClientProvider client={new QueryClient()}>
        <RefreshButton />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('the refresh button', () => {
  it('is labelled in both languages', () => {
    expect(render('en')).toContain('Refresh');
    expect(render('ar')).toContain('تحديث');
  });

  it('fetches the open screen again and marks everything else out of date', async () => {
    const queries = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    let companies = ['Acme'];
    let fetched = 0;
    const onScreen = new QueryObserver(queries, {
      queryKey: ['staff', 'companies', ''],
      queryFn: () => {
        fetched += 1;
        return [...companies];
      },
    });
    const stop = onScreen.subscribe(() => undefined);
    await queries.fetchQuery({ queryKey: ['staff', 'companies', ''], queryFn: () => companies });
    queries.setQueryData(['elsewhere'], 'old');
    const before = fetched;

    // A company is added somewhere else; the list still holds what it had.
    companies = ['Acme', 'Newco'];
    expect(queries.getQueryData(['staff', 'companies', ''])).toEqual(['Acme']);

    await refreshAll(queries);
    expect(fetched).toBe(before + 1);
    expect(queries.getQueryData(['staff', 'companies', ''])).toEqual(['Acme', 'Newco']);
    expect(queries.getQueryState(['elsewhere'])?.isInvalidated).toBe(true);
    stop();
    queries.clear();
  });
});
