import { PLATFORM_NAV_SECTIONS } from '@integr8/core';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PLATFORM_ROUTES, platformSectionFor } from './frame';
import { CompanyRoute } from './screens/company';

describe('the staff dashboard’s menu (P42)', () => {
  it('gives every section a route under /platform, and no funnel', () => {
    for (const section of PLATFORM_NAV_SECTIONS) {
      expect(PLATFORM_ROUTES[section.key], section.key).toMatch(/^\/platform(\/[a-z]+)?$/u);
    }
    expect(Object.keys(PLATFORM_ROUTES)).not.toContain('funnel');
  });

  it('marks Companies on a company’s page, and each section on its own', () => {
    expect(platformSectionFor('/platform')).toBe('companies');
    expect(platformSectionFor('/platform/companies/abc')).toBe('companies');
    expect(platformSectionFor('/platform/plans')).toBe('plans');
    expect(platformSectionFor('/platform/downloads/')).toBe('downloads');
    expect(platformSectionFor('/dashboard')).toBeUndefined();
  });
});

describe('a company’s page', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';

  function render(companyApp: string): string {
    const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    queries.setQueryData(['platform', 'company', TENANT], {
      id: TENANT,
      slug: 'nile',
      name: 'Nile Services',
      status: 'active',
      plan: 'standard',
      seats: null,
      members: 1,
      activeMembers: 1,
      storageBytes: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
      lastActivityAt: null,
      suspendedAt: null,
      suspendedReason: null,
      deletionScheduledFor: null,
      isTest: false,
      settings: {
        logoMediaId: null,
        appIconMediaId: null,
        brandColour: null,
        shellColour: null,
        defaultTheme: 'system',
        websiteUrl: null,
        appsEnabled: false,
        aiDesktopEnabled: false,
        aiMobileEnabled: false,
        showCompanyName: true,
        documentLinkPattern: null,
        hiddenSections: [],
        tabs: [],
      },
      companyApp,
      invitations: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'owner@nile.example',
          role: 'owner',
          createdAt: '2026-11-01T00:00:00.000Z',
          expiresAt: '2026-11-08T00:00:00.000Z',
          expired: false,
        },
      ],
      activity: [],
      billing: null,
      featureFlags: {},
      owners: [],
    });
    return renderToStaticMarkup(
      <I18nextProvider i18n={createI18n({ locale: 'en' })}>
        <QueryClientProvider client={queries}>
          <MemoryRouter initialEntries={[`/platform/companies/${TENANT}`]}>
            <Routes>
              <Route path="/platform/companies/:tenantId" element={<CompanyRoute />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
  }

  it('offers to work inside the company', () => {
    expect(render('ready')).toContain('Work inside this company');
  });

  it('holds the owner’s invitation until the company’s desktop app is built (D6)', () => {
    const waiting = render('not_built');
    expect(waiting).toContain('which has not been built yet');
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Send invitation/u);

    const ready = render('ready');
    expect(ready).not.toContain('Invitations wait for');
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Send invitation/u);
  });
});
