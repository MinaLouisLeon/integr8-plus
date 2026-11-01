// @vitest-environment jsdom
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExportFormDialog,
  fileRefusal,
  type ImportedForm,
  ImportFormDialog,
  ImportResult,
  packageFilename,
} from './form-package';

/**
 * Export and import of a `.integr8form` file in the staff app (decision 14,
 * 1.3.0): the export's choice of version, the import's checks before
 * uploading, and the result that says what to fix before publishing.
 */

const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('~/lib/session', () => ({ session: () => ({ client: api }) }));

beforeAll(() => {
  // jsdom has `<dialog>` without its modal methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  api.GET.mockReset();
  api.POST.mockReset();
});

function wrap(children: ReactNode, locale: 'en' | 'ar' = 'en') {
  return render(
    <I18nextProvider i18n={createI18n({ locale })}>
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    </I18nextProvider>,
  );
}

const result = (overrides: Partial<ImportedForm> = {}): ImportedForm => ({
  formId: '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d',
  title: 'Boiler service (imported)',
  documentTemplatesCreated: 1,
  imagesCopied: 2,
  source: {
    app: 'integr8-plus',
    version: '1.3.0',
    createdAt: '2026-11-01T09:30:00.000Z',
    exportedFrom: 'published',
    versionNumber: 3,
  },
  check: {
    ok: false,
    problemCount: 1,
    warningCount: 3,
    problems: [
      {
        entry: 'form.json',
        path: 'definition.pages[0].sections[0].fields[1]',
        code: 'duplicate_id',
        message: 'The id "customer" is used twice.',
      },
    ],
    warnings: [
      {
        entry: 'form.json',
        path: 'definition.title',
        code: 'translation_missing',
        message: 'This text has no Arabic.',
      },
      {
        entry: 'form.json',
        path: 'definition.pages[0].title',
        code: 'translation_missing',
        message: 'This text has no Arabic.',
      },
      {
        entry: 'manifest.json',
        path: 'form.title',
        code: 'title_mismatch',
        message: 'The manifest’s title differs.',
      },
    ],
  },
  ...overrides,
});

describe('packageFilename and fileRefusal', () => {
  it('names the file as the server does', () => {
    expect(packageFilename('Gas: safety / test?')).toBe('Gas safety test.integr8form');
    expect(packageFilename('شهادة')).toBe('شهادة.integr8form');
  });

  it('refuses another kind of file, or one past 50 MB, before uploading', () => {
    const t = createI18n({ locale: 'en' }).t;
    expect(fileRefusal({ name: 'form.zip', size: 10 }, t)).toMatch(/\.integr8form/u);
    expect(fileRefusal({ name: 'Form.INTEGR8FORM', size: 10 }, t)).toBeUndefined();
    expect(fileRefusal({ name: 'big.integr8form', size: 51 * 1024 * 1024 }, t)).toMatch(/50 MB/u);
  });
});

describe('ExportFormDialog', () => {
  it('offers the published version or the draft, and saves the chosen one', async () => {
    const blob = new Blob(['zip']);
    api.GET.mockResolvedValue({ data: blob });
    const save = vi.fn();
    const done = vi.fn();
    wrap(
      <ExportFormDialog
        open
        formId="form-1"
        formTitle="Boiler service"
        publishedVersion={3}
        hasDraft
        onClose={() => undefined}
        onDone={done}
        save={save}
      />,
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('The published version (version 3)').checked,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText('The draft, with the changes not yet published'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('Boiler service.integr8form'));
    expect(api.GET).toHaveBeenCalledWith('/v1/forms/{formId}/export', {
      params: { path: { formId: 'form-1' }, query: { source: 'draft' } },
      parseAs: 'blob',
    });
    expect(save).toHaveBeenCalledWith(blob, 'Boiler service.integr8form');
  });

  it('exports the draft of a form never published, without a choice', () => {
    wrap(
      <ExportFormDialog
        open
        formId="form-1"
        formTitle="Half built"
        publishedVersion={null}
        hasDraft
        onClose={() => undefined}
        onDone={() => undefined}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText(/The draft is exported/u)).toBeTruthy();
  });
});

describe('ImportFormDialog', () => {
  it('sends the chosen file as it is and shows what was created', async () => {
    api.POST.mockResolvedValue({ data: result() });
    const openDraft = vi.fn();
    wrap(<ImportFormDialog open onClose={() => undefined} onOpenDraft={openDraft} />);
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'boiler.integr8form');
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(
      await screen.findByText('“Boiler service (imported)” was created as an unpublished draft.'),
    ).toBeTruthy();
    const [path, options] = api.POST.mock.calls[0] as [
      string,
      { body: unknown; headers: Record<string, string> },
    ];
    expect(path).toBe('/v1/forms/import');
    expect(options.body).toBe(file);
    expect(options.headers['content-type']).toBe('application/vnd.integr8.form+zip');

    fireEvent.click(screen.getByRole('button', { name: 'Open the draft' }));
    expect(openDraft).toHaveBeenCalledWith('0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d');
  });

  it('refuses a file that is not a .integr8form without sending it', () => {
    wrap(<ImportFormDialog open onClose={() => undefined} onOpenDraft={() => undefined} />);
    const file = new File(['x'], 'notes.txt');
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    expect(screen.getByRole('alert').textContent).toContain('.integr8form');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(true);
    expect(api.POST).not.toHaveBeenCalled();
  });
});

describe('ImportResult', () => {
  it('lists what to fix before publishing, and sums up missing translations', () => {
    wrap(
      <ImportResult result={result()} onOpenDraft={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getByText('To fix before publishing')).toBeTruthy();
    expect(screen.getByText('The id "customer" is used twice.')).toBeTruthy();
    expect(screen.getByText('form.json · definition.pages[0].sections[0].fields[1]')).toBeTruthy();
    expect(screen.getByText(/Texts without English or Arabic: 2\./u)).toBeTruthy();
    expect(
      screen.getByText('The file’s name for the form differs from the form’s own title.'),
    ).toBeTruthy();
  });

  it('says so when nothing stops publishing, in Arabic too', () => {
    wrap(
      <ImportResult
        result={result({
          check: { ok: true, problemCount: 0, warningCount: 0, problems: [], warnings: [] },
        })}
        onOpenDraft={() => undefined}
        onClose={() => undefined}
      />,
      'ar',
    );
    expect(screen.getByText('لا شيء يمنع نشر هذا النموذج.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'فتح المسودة' })).toBeTruthy();
  });
});
