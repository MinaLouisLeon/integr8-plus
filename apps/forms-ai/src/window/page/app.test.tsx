// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { tripForm } from '../testing/trip-form.js';
import type { WindowApi, WindowState } from './api.js';
import { App } from './app.js';

/**
 * The window's page, rendered as the other DOM packages render theirs: the
 * product's filler on a form with a condition, a calculation and a repeating
 * section, in English and Arabic, refreshed by the program's events.
 */

configure({ asyncUtilTimeout: 5000 });
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
});

interface FakeApi extends WindowApi {
  posts: { path: string; body: unknown }[];
  current: WindowState;
  /** The program says the state changed (the AI called update_preview). */
  push(change: Partial<WindowState>): void;
  open(): void;
}

function fakeApi(initial: Partial<WindowState> = {}): FakeApi {
  let handlers: Parameters<WindowApi['events']>[0] | undefined;
  const api: FakeApi = {
    posts: [],
    current: {
      version: 1,
      hasContent: true,
      definition: tripForm,
      templates: [{ name: 'Trip report', language: null }],
      check: { ok: true, problems: [], warnings: [] },
      checkText: 'OK: the form would publish. 0 warnings.',
      summary: '# Car trip',
      answers: {},
      submitted: null,
      prints: {},
      printing: { available: false },
      view: { tab: 'form', language: 'en', width: 'desktop', theme: 'light' },
      outputFolder: '/home/staff/Documents/Integr8 forms',
      ...initial,
    },
    href: (path) => `${path}?k=token`,
    state: () => Promise.resolve(structuredClone(api.current)),
    requests: () =>
      Promise.resolve([
        {
          number: 1,
          title: 'Mileage claims from a form',
          kind: 'form_action',
          status: 'open',
          date: '2026-11-10',
        },
      ]),
    post: (path, body) => {
      api.posts.push({ path, body });
      if (path === '/answers') {
        api.current.answers = (body as { answers: Record<string, unknown> }).answers;
      }
      if (path === '/print') {
        api.current.prints = {
          '0': {
            status: 'unavailable',
            version: api.current.version,
            options: { useAnswers: false },
            by: 'window',
            at: new Date().toISOString(),
            message: 'No Chrome, Edge or Chromium was found on this computer.',
            pageCount: null,
          },
        };
        handlers?.onPdf();
      }
      return Promise.resolve({ ok: true });
    },
    events: (given) => {
      handlers = given;
      return () => {
        handlers = undefined;
      };
    },
    media: {
      upload: (file, options) =>
        Promise.resolve({
          mediaId: '00000000-0000-4000-8000-000000000001',
          contentType: options.contentType,
          byteSize: file.size,
        }),
      url: () => Promise.resolve('/media/1?k=token'),
    },
    push: (change) => {
      api.current = { ...api.current, ...change };
      handlers?.onState();
    },
    open: () => {
      handlers?.onOpen();
    },
  };
  return api;
}

function show(api: FakeApi, blank = false) {
  return render(
    <I18nextProvider i18n={createI18n({ locale: 'en' })}>
      <App api={api} blank={blank} />
    </I18nextProvider>,
  );
}

describe('the preview window page', () => {
  it('shows the form in the product filler, and says when it is live', async () => {
    const api = fakeApi();
    show(api);
    expect(await screen.findByRole('heading', { name: 'Car trip', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Purpose/u })).toBeRequired();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    act(() => {
      api.open();
    });
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('runs conditions, calculations and repeating sections as the app does', async () => {
    const user = userEvent.setup();
    show(fakeApi());
    await screen.findByRole('textbox', { name: /Purpose/u });
    expect(screen.queryByRole('textbox', { name: /Kilometres/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.type(await screen.findByRole('textbox', { name: /Kilometres/u }), '40');
    expect(screen.getByRole('status', { name: 'Allowance' })).toHaveTextContent('80');
    await user.click(screen.getByRole('button', { name: /Add Stop/u }));
    expect(await screen.findByRole('textbox', { name: /Place/u })).toBeInTheDocument();
  });

  it('sends what is typed to the program, and keeps it when the AI changes the form', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    show(api);
    await user.type(await screen.findByRole('textbox', { name: /Purpose/u }), 'Audit');
    await waitFor(() => {
      expect(api.current.answers).toMatchObject({ purpose: 'Audit' });
    });
    const renamed = structuredClone(tripForm);
    renamed.title.en = 'Business trip';
    act(() => {
      api.push({ version: 2, definition: renamed });
    });
    expect(
      await screen.findByRole('heading', { name: 'Business trip', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The AI changed the form/u)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Purpose/u })).toHaveValue('Audit');
  });

  it('switches to Arabic, right to left, and tells the program the view', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    show(api);
    await screen.findByRole('textbox', { name: /Purpose/u });
    await user.click(screen.getByRole('button', { name: 'العربية' }));
    expect(await screen.findByRole('textbox', { name: /الغرض/u })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'رحلة بالسيارة', level: 1 })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    await waitFor(() => {
      expect(api.posts).toContainEqual({
        path: '/view',
        body: { tab: 'form', language: 'ar', width: 'desktop', theme: 'light' },
      });
    });
  });

  it("shows the check's problems where the form cannot be shown", async () => {
    show(
      fakeApi({
        definition: { schemaVersion: 2, title: { en: 'Broken' }, pages: 'none' },
        check: {
          ok: false,
          problems: [
            {
              code: 'invalid_structure',
              message: 'Pages must be a list',
              path: 'pages',
              entry: 'form.json',
            },
          ],
          warnings: [],
        },
      }),
    );
    expect(await screen.findByText(/cannot be shown yet/u)).toBeInTheDocument();
    expect(screen.getByText('Pages must be a list')).toBeInTheDocument();
  });

  it('asks for a print when the PDF tab opens, and says why there is none', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    show(api);
    await user.click(await screen.findByRole('tab', { name: 'PDF' }));
    await waitFor(() => {
      expect(api.posts.some((post) => post.path === '/print')).toBe(true);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/No Chrome, Edge or Chromium/u);
    expect(screen.getByRole('button', { name: 'Print again' })).toBeDisabled();
  });

  it('leaves a note about a question for the AI', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    show(api);
    await screen.findByRole('textbox', { name: /Purpose/u });
    await user.type(
      screen.getByRole('textbox', { name: /Leave a note for the AI/u }),
      'This label is too long',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'About' }), 'km');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(api.posts).toContainEqual({
      path: '/note',
      body: { tab: 'form', about: 'km', text: 'This label is too long' },
    });
    expect(await screen.findByText(/Sent\./u)).toBeInTheDocument();
  });

  it('shows the check report and the question list', async () => {
    const user = userEvent.setup();
    show(fakeApi());
    await user.click(await screen.findByRole('tab', { name: 'Checks' }));
    const report = screen.getByRole('region', { name: 'Check report' });
    expect(within(report).getByText(/OK: the form would publish/u)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Questions' })).toHaveTextContent('# Car trip');
  });

  it('sends a platform suggestion to the AI', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    show(api);
    await user.click(
      await screen.findByRole('button', { name: 'Suggest a change to the platform' }),
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Suggest a change to the platform' }),
      'Make expense claims from this form',
    );
    await user.click(screen.getByRole('button', { name: 'Send to the AI' }));
    expect(api.posts).toContainEqual({
      path: '/note',
      body: { tab: 'form', text: 'Make expense claims from this form', platform: true },
    });
    expect(await screen.findByText(/Ask the AI to look at your suggestion/u)).toBeInTheDocument();
  });

  it('lists the change requests on the Checks tab', async () => {
    const user = userEvent.setup();
    show(fakeApi());
    await user.click(await screen.findByRole('tab', { name: 'Checks' }));
    const list = screen.getByRole('region', { name: 'Change requests' });
    expect(await within(list).findByText(/Mileage claims from a form — Open/u)).toBeInTheDocument();
  });

  it('shows the form with nothing typed, and sends nothing, when blank', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ answers: { purpose: 'Real customer visit' } });
    show(api, true);
    const purpose = await screen.findByRole('textbox', { name: /Purpose/u });
    expect(purpose).toHaveValue('');
    await user.type(purpose, 'x');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.posts.filter((post) => post.path === '/answers' || post.path === '/view')).toEqual(
      [],
    );
    expect(screen.queryByRole('button', { name: /Save the form file/u })).not.toBeInTheDocument();
  });
});
