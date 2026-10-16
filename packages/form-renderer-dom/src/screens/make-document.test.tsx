import { createClient } from '@integr8/api-client';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { type ScreensConfig, ScreensContext } from './api.js';
import { MakeDocumentButton } from './make-document.js';

const SUBMISSION = '00000000-0000-4000-8000-000000000901';
const FORM = '00000000-0000-4000-8000-000000000501';
const TEMPLATE = '00000000-0000-4000-8000-000000000a01';
const DOCUMENT = '00000000-0000-4000-8000-000000000b01';

interface Sent {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
}

function server(options: { features?: Record<string, boolean>; permissions?: string[] } = {}) {
  const sent: Sent[] = [];
  let polls = 0;
  const document = (status: 'pending' | 'ready') => ({
    id: DOCUMENT,
    title: 'Gas certificate · GS-1',
    templateId: TEMPLATE,
    templateRevision: 1,
    submissionId: SUBMISSION,
    formId: FORM,
    status,
    failureCode: null,
    linkOpens: status === 'ready',
    link: 'https://app.example.com/d/abcdefghijklmnopqrstuv',
    publicCode: 'abcdefghijklmnopqrstuv',
    pageCount: status === 'ready' ? 1 : null,
    byteSize: status === 'ready' ? 1000 : null,
    renderedAt: null,
    expiredAt: null,
    expiresAt: null,
    createdBy: { id: 'u', name: 'Sam' },
    createdAt: '2026-10-16T09:00:00.000Z',
    fields: [],
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
      idempotencyKey: request.headers.get('idempotency-key'),
    });
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const key = `${request.method} ${url.pathname}`;
    if (key === 'GET /v1/me') {
      return reply({
        permissions: options.permissions ?? ['document.create'],
        features: options.features ?? { documents: true },
      });
    }
    if (key === 'GET /v1/document-templates') {
      return reply({
        items: [
          {
            id: TEMPLATE,
            formId: FORM,
            name: 'Gas certificate',
            revision: 1,
            archived: false,
            createdAt: '2026-10-16T08:00:00.000Z',
            updatedAt: '2026-10-16T08:00:00.000Z',
            design: {
              fields: [
                {
                  key: 'certificate',
                  label: { en: 'Certificate number' },
                  source: { kind: 'typed', required: true, maxLength: 40 },
                  lookup: 'key',
                },
                {
                  key: 'customer',
                  label: { en: 'Customer' },
                  source: { kind: 'answer', fieldId: 'customer' },
                  lookup: 'none',
                },
              ],
            },
          },
        ],
      });
    }
    if (key === `POST /v1/submissions/${SUBMISSION}/documents`) {
      return reply(document('pending'), 202);
    }
    if (key === `GET /v1/documents/${DOCUMENT}`) {
      polls += 1;
      return reply(document(polls > 1 ? 'ready' : 'pending'));
    }
    if (key === `GET /v1/documents/${DOCUMENT}/file`) {
      return reply({ url: 'https://files.example/pdf', expiresAt: '2026-10-16T09:05:00.000Z' });
    }
    return reply({ error: { code: 'not_found', message: 'no', requestId: 'r' } }, 404);
  };
  const client = createClient({
    baseUrl: 'https://api.test',
    clientApp: 'web',
    clientVersion: '1.0.0',
    getAccessToken: () => 'token',
    fetch: fetchImpl,
  });
  return { client, sent };
}

function show(client: ScreensConfig['client'], isDraft = false) {
  const navigate = vi.fn();
  render(
    <I18nextProvider i18n={createI18n({ locale: 'en' })}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ScreensContext.Provider
          value={{
            client,
            locale: 'en',
            navigate,
            download: vi.fn(),
            paths: {
              fill: '/fill',
              submissions: '/submissions',
              submission: (id) => `/submissions/${id}`,
              document: (id) => `/documents/${id}`,
            },
          }}
        >
          <MakeDocumentButton submissionId={SUBMISSION} formId={FORM} isDraft={isDraft} />
        </ScreensContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { navigate };
}

describe('making a PDF from a submission', () => {
  it('asks for the typed fields, makes the PDF, waits for it, and offers it', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { client, sent } = server();
    const { navigate } = show(client);
    await user.click(await screen.findByRole('button', { name: 'Make PDF' }));
    const dialog = await screen.findByRole('dialog', { name: 'Make a PDF from this submission' });
    expect(within(dialog).getByText('Gas certificate')).toBeInTheDocument();
    // Only the typed field is asked for; the answer is taken from the submission.
    expect(within(dialog).queryByLabelText(/Customer/u)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Certificate number/u), '  GS-1 ');
    await user.click(within(dialog).getByRole('button', { name: 'Make PDF' }));

    expect(
      await within(dialog).findByText('The PDF is ready.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const made = sent.find((request) => request.method === 'POST')!;
    expect(made.body).toEqual({ templateId: TEMPLATE, fields: { certificate: 'GS-1' } });
    expect(made.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);

    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://files.example/pdf', '_blank', 'noopener'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Open the document' }));
    expect(navigate).toHaveBeenCalledWith(`/documents/${DOCUMENT}`);
    open.mockRestore();
  });

  it('is not offered without the module', async () => {
    const off = server({ features: {} });
    show(off.client);
    await waitFor(() => expect(off.sent.some((request) => request.path === '/v1/me')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Make PDF' })).not.toBeInTheDocument();
  });

  it('is not offered without the permission', async () => {
    const viewer = server({ permissions: ['document.read'] });
    show(viewer.client);
    await waitFor(() =>
      expect(viewer.sent.some((request) => request.path === '/v1/me')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Make PDF' })).not.toBeInTheDocument();
  });

  it('is not offered for a draft', async () => {
    const draft = server();
    show(draft.client, true);
    await waitFor(() => expect(draft.sent.some((request) => request.path === '/v1/me')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Make PDF' })).not.toBeInTheDocument();
  });
});
