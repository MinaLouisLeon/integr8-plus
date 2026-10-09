import { createClient } from '@integr8/api-client';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type ScreensConfig, ScreensContext } from './api.js';
import { SubmissionListScreen } from './submission-list.js';
import { SubmissionScreen } from './submission-screen.js';

const SUBMISSION = '00000000-0000-4000-8000-000000000901';
const JOB = '00000000-0000-4000-8000-000000000101';
const FORM = '00000000-0000-4000-8000-000000000501';
const PERSON = { id: '00000000-0000-4000-8000-000000000401', name: 'Sam Carter' };
const WORK_ORDER = { id: JOB, reference: 123, referenceLabel: 'WO-000123' };

/** A server in a function: each route answers with a status and a body. */
function fakeClient(routes: Record<string, () => { status?: number; body: unknown }>) {
  const fetchImpl: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const route = routes[`${request.method} ${path}`];
    const { status = 200, body } = route?.() ?? {
      status: 404,
      body: { error: { code: 'not_found', message: 'Not found', requestId: 'req-test' } },
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return createClient({
    baseUrl: 'https://api.test',
    clientApp: 'web',
    clientVersion: '1.0.0',
    getAccessToken: () => 'token',
    fetch: fetchImpl,
  });
}

function renderScreen(
  element: ReactElement,
  client: ScreensConfig['client'],
  overrides: Partial<Omit<ScreensConfig, 'paths'>> & {
    paths?: Partial<ScreensConfig['paths']>;
  } = {},
) {
  const navigate = vi.fn();
  const { paths, ...rest } = overrides;
  const config: ScreensConfig = {
    client,
    locale: 'en',
    navigate,
    download: vi.fn(),
    paths: {
      fill: '/fill',
      submissions: '/submissions',
      submission: (id) => `/submissions/${id}`,
      ...paths,
    },
    ...rest,
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <I18nextProvider i18n={createI18n({ locale: 'en' })}>
      <QueryClientProvider client={queryClient}>
        <ScreensContext.Provider value={config}>{element}</ScreensContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { navigate };
}

const summary = {
  id: SUBMISSION,
  workOrder: WORK_ORDER,
  formId: FORM,
  formTitle: 'Gas safety record',
  formVersionId: '00000000-0000-4000-8000-000000000511',
  versionNumber: 2,
  status: 'submitted',
  revision: 3,
  submittedBy: PERSON,
  submittedAt: '2026-10-01T12:00:00.000Z',
  amendedAt: null,
  createdAt: '2026-10-01T11:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

const listRoutes = {
  'GET /v1/me': () => ({ body: { permissions: [] } }),
  'GET /v1/forms': () => ({ body: { items: [] } }),
  'GET /v1/customers': () => ({ body: { items: [], nextCursor: null } }),
  'GET /v1/submissions': () => ({ body: { items: [summary], nextCursor: null } }),
};

describe('the submission screen', () => {
  it('shows the way back while it loads and when it fails to', async () => {
    renderScreen(<SubmissionScreen submissionId={SUBMISSION} />, fakeClient({}));
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('link', { name: 'All submissions' })).toHaveAttribute(
      'href',
      '/submissions',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This submission does not exist, or you cannot see it.',
    );
    expect(screen.getByRole('link', { name: 'All submissions' })).toBeInTheDocument();
  });

  it('leads back to the job a submission was made for', async () => {
    const client = fakeClient({
      [`GET /v1/submissions/${SUBMISSION}`]: () => ({
        body: {
          submission: { ...summary, answers: { note: 'Flue checked' } },
          version: {
            id: summary.formVersionId,
            versionNumber: 2,
            definition: {
              schemaVersion: 1,
              title: { en: 'Gas safety record' },
              pages: [
                {
                  id: 'page_1',
                  sections: [
                    {
                      id: 'section_1',
                      fields: [{ id: 'note', type: 'text', label: { en: 'Note' } }],
                    },
                  ],
                },
              ],
            },
          },
          events: [],
          can: { edit: false, reopen: false },
        },
      }),
    });
    const { navigate } = renderScreen(<SubmissionScreen submissionId={SUBMISSION} />, client, {
      paths: { workOrder: (id) => `/work-orders/${id}` },
    });
    const back = await screen.findByRole('link', { name: 'Back to job WO-000123' });
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledWith(`/work-orders/${JOB}`);
  });
});

describe('the submissions list', () => {
  it('leads back to the job it was opened for', async () => {
    renderScreen(<SubmissionListScreen workOrderId={JOB} />, fakeClient(listRoutes), {
      paths: { workOrder: (id) => `/work-orders/${id}`, dashboard: '/' },
    });
    expect(await screen.findByRole('link', { name: 'Back to job WO-000123' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(screen.queryByRole('link', { name: 'Back to Dashboard' })).not.toBeInTheDocument();
  });

  it('hands a row’s actions to the app’s menu, and leaves the browser’s alone without one', async () => {
    const rowActions = vi.fn();
    renderScreen(<SubmissionListScreen />, fakeClient(listRoutes), {
      rowActions,
      paths: { workOrder: (id) => `/work-orders/${id}` },
    });
    const open = await screen.findByRole('button', {
      name: 'Open Gas safety record by Sam Carter',
    });
    expect(fireEvent.contextMenu(open.closest('tr')!, { clientX: 5, clientY: 6 })).toBe(false);
    const [target, actions] = rowActions.mock.calls[0] as [
      { kind: string; id: string },
      { key: string; label: string }[],
    ];
    expect(target).toMatchObject({ kind: 'submission', id: SUBMISSION });
    expect(actions.map((action) => action.label)).toEqual([
      'Open',
      'Open job WO-000123',
      'Copy ID',
    ]);
  });

  it('keeps the browser’s menu when the app has none', async () => {
    renderScreen(<SubmissionListScreen />, fakeClient(listRoutes));
    const open = await screen.findByRole('button', {
      name: 'Open Gas safety record by Sam Carter',
    });
    expect(fireEvent.contextMenu(open.closest('tr')!)).toBe(true);
  });
});
