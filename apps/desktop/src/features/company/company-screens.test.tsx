import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BillingRoute } from './billing';
import { CompanySettingsRoute } from './company-settings';
import { GetStartedRoute } from './get-started';
import { PeopleRoute } from './people';
import { StorageRoute } from './storage';
import { WebsiteAccessRoute } from './website-access';

/**
 * The company screens that came over from the web workspace (P42), drawn
 * from what the API answers. Each is given its answer in the query cache, as
 * if it had just been read, so these check the screen and not the network.
 */

function render(
  screen: ReactNode,
  answers: readonly [readonly unknown[], unknown][],
  locale: 'en' | 'ar' = 'en',
): string {
  const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const [key, data] of answers) {
    queries.setQueryData(key, data);
  }
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <QueryClientProvider client={queries}>
        <MemoryRouter>{screen}</MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const SUBSCRIPTION = {
  plan: 'standard',
  status: 'active',
  trialEndsAt: null,
  readOnly: false,
  readOnlyReason: null,
  entitlements: { seats: 50, storageBytes: 536_870_912_000, submissionsPerMonth: 20_000 },
  usage: { seatsUsed: 7, submissionsThisMonth: 120 },
};

describe('billing', () => {
  it('shows the plan, the limits and who invoices, with nothing to pay', () => {
    const html = render(<BillingRoute />, [[['billing', 'subscription'], SUBSCRIPTION]]);
    expect(html).toContain('Standard');
    expect(html).toMatch(/7\D+50/u);
    expect(html).not.toMatch(/checkout|card/iu);
    expect(html).not.toContain('<button');
  });

  it('says why writes are refused when the company is read-only', () => {
    const html = render(<BillingRoute />, [
      [
        ['billing', 'subscription'],
        { ...SUBSCRIPTION, readOnly: true, readOnlyReason: 'Paused by Integr8.' },
      ],
    ]);
    expect(html).toContain('Paused by Integr8.');
  });

  it('reads in Arabic', () => {
    const html = render(<BillingRoute />, [[['billing', 'subscription'], SUBSCRIPTION]], 'ar');
    expect(html).toContain('الخطة:');
  });
});

describe('company settings', () => {
  const settings = {
    logoMediaId: null,
    aiDesktopEnabled: true,
    aiMobileEnabled: false,
    brandColour: null,
    shellColour: null,
    defaultTheme: 'system',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    locale: 'en',
    workDayStarts: 480,
    workDayEnds: 1020,
    workingDays: [7, 1, 2, 3, 4],
    websiteUrl: null,
    appIconMediaId: null,
    appsEnabled: true,
    showCompanyName: true,
  };

  it('offers the assistant on the desktop and the phone only (P42)', () => {
    const html = render(<CompanySettingsRoute />, [[['settings'], settings]]);
    expect(html).toContain('Africa/Cairo');
    expect(html).toContain('EGP');
    expect(html).toContain('Show the assistant in the desktop app');
    expect(html).not.toContain('web app');
  });
});

describe('website access', () => {
  it('lists the four switches as they stand', () => {
    const html = render(<WebsiteAccessRoute />, [
      [
        ['settings', 'website-access'],
        {
          websiteFilesEnabled: true,
          websiteJobsEnabled: false,
          websiteQuotesEnabled: false,
          websiteInvoicesEnabled: false,
        },
      ],
    ]);
    expect(html.match(/type="checkbox"/gu)).toHaveLength(4);
    expect(html.match(/checked=""/gu)).toHaveLength(1);
  });
});

describe('getting started', () => {
  it('ticks what is done and links each step to the screen that does it', () => {
    const html = render(<GetStartedRoute />, [
      [
        ['onboarding'],
        {
          steps: [
            { key: 'job_type', done: true },
            { key: 'form', done: false },
            { key: 'member', done: false },
            { key: 'customer', done: false },
            { key: 'submission', done: false },
          ],
          complete: false,
          demo: { loaded: false, customers: 0, sites: 0, workOrders: 0 },
        },
      ],
    ]);
    expect(html).toContain('href="/settings/job-types"');
    expect(html).toContain('href="/forms"');
    expect(html).toContain('href="/settings/people"');
    expect(html).toContain('✓');
  });
});

describe('storage', () => {
  it('draws without an answer yet', () => {
    // The loading state: the screen must not fail before the usage arrives.
    expect(render(<StorageRoute />, [])).toContain('role="status"');
  });
});

describe('people', () => {
  it('lists the people, links to company roles, and gives an owner the invite form', () => {
    const html = render(<PeopleRoute />, [
      [
        ['me'],
        {
          userId: 'u-owner',
          role: 'owner',
          permissions: ['member.read', 'member.invite', 'member.update_role', 'member.remove'],
        },
      ],
      [
        ['members'],
        {
          items: [
            {
              userId: 'u-owner',
              email: 'owner@nile.example',
              displayName: 'Nadia Owner',
              role: 'owner',
              grants: [],
              status: 'active',
              aiEnabled: true,
            },
            {
              userId: 'u-eng',
              email: 'omar@nile.example',
              displayName: 'Omar Engineer',
              role: 'engineer',
              grants: [],
              status: 'active',
              aiEnabled: false,
            },
          ],
        },
      ],
      [['members', 'invitations'], { items: [] }],
    ]);
    expect(html).toContain('Nadia Owner');
    expect(html).toContain('Omar Engineer');
    // Roles are given here, and made on the Company roles screen beside it.
    expect(html).toContain('href="/settings/roles"');
    expect(html).toContain('type="email"');
  });
});
