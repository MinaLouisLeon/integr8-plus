import { createClient } from '@integr8/api-client';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { type OperationsConfig, OperationsContext } from '../api.js';

/**
 * A server in a function: requests are matched by method and path pattern, and
 * each handler returns a status and a body. Everything the screens send goes
 * through the real generated client, so a request the contract does not allow
 * fails to compile in the test as it would in the app.
 */

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (call: Call, params: Record<string, string>) => { status?: number; body?: unknown };

export function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    const names: string[] = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([a-zA-Z]+)/gu, (_match, name: string) => {
        names.push(name);
        return '([^/]+)';
      })}$`,
      'u',
    );
    return { method, regex, names, handler };
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
    calls.push(call);
    for (const route of compiled) {
      const match = route.method === request.method ? route.regex.exec(url.pathname) : null;
      if (match !== null) {
        const params = Object.fromEntries(
          route.names.map((name, index) => [name, match[index + 1]!]),
        );
        const { status = 200, body } = route.handler(call, params);
        return new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(
      JSON.stringify({
        error: {
          code: 'not_found',
          message: `No fake for ${request.method} ${url.pathname}`,
          requestId: 'test',
        },
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  };

  const client = createClient({
    baseUrl: 'https://api.test',
    clientApp: 'web',
    clientVersion: '1.0.0',
    getAccessToken: () => 'token',
    fetch: fetchImpl,
  });
  return { client, calls };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details: { field: string; code: string; message: string }[] = [],
) {
  return { status, body: { error: { code, message, requestId: 'req-test', details } } };
}

export function renderScreen(
  element: ReactElement,
  client: OperationsConfig['client'],
): RenderResult & { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const config: OperationsConfig = {
    client,
    locale: 'en',
    navigate,
    download: vi.fn(),
    timeZone: 'Europe/London',
    paths: {
      workOrders: '/work-orders',
      newWorkOrder: () => '/work-orders/new',
      workOrder: (id) => `/work-orders/${id}`,
      customers: '/customers',
      customer: (id) => `/customers/${id}`,
      site: (id) => `/sites/${id}`,
      jobTypes: '/settings/job-types',
      imports: '/imports',
      submission: (id) => `/submissions/${id}`,
      submissionsForWorkOrder: (id) => `/submissions?workOrderId=${id}`,
    },
  };
  const result = render(
    <I18nextProvider i18n={createI18n({ locale: 'en' })}>
      <QueryClientProvider client={queryClient}>
        <OperationsContext.Provider value={config}>{element}</OperationsContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return Object.assign(result, { navigate });
}

/** Accessibility violations axe can find. Colour contrast is off: jsdom computes no styles. */
export async function accessibilityViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}
