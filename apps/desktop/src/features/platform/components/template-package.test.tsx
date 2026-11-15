import { ApiRequestError } from '@integr8/api-client';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type ImportedTemplate,
  packageFilename,
  TemplateImportRefusal,
  TemplateImportResult,
} from './template-package';

/**
 * The dashboard's Templates page and `.integr8form` files (decision 14,
 * 1.3.0): what an import made, and why a file was refused.
 */

function render(node: ReactNode, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>{node}</I18nextProvider>,
  );
}

const imported: ImportedTemplate = {
  template: {
    key: 'boiler_service_2',
    title: { en: 'Boiler service', ar: 'صيانة الغلاية' },
    description: {},
    category: 'maintenance',
    definitionSchemaVersion: 1,
    updatedAt: '2026-11-01T09:30:00.000Z',
    source: 'staff',
    retiredAt: null,
    origin: null,
    documentTemplateCount: 1,
  },
  source: {
    app: 'integr8-plus',
    version: '1.3.0',
    createdAt: '2026-11-01T09:30:00.000Z',
    exportedFrom: 'published',
    versionNumber: 3,
  },
  documentTemplatesCreated: 1,
  imagesCopied: 2,
  check: {
    ok: true,
    problemCount: 0,
    warningCount: 1,
    problems: [],
    warnings: [
      {
        entry: 'form.json',
        path: 'definition.pages[0].title',
        code: 'translation_missing',
        message: 'This text has no Arabic.',
      },
    ],
  },
};

describe('the template import', () => {
  it('names the new template and its key, in English and Arabic', () => {
    expect(render(<TemplateImportResult result={imported} />)).toContain(
      'Added “Boiler service” to the library as “boiler_service_2”.',
    );
    const arabic = render(<TemplateImportResult result={imported} />, 'ar');
    expect(arabic).toContain('أُضيف «صيانة الغلاية» إلى المكتبة باسم «boiler_service_2».');
    expect(arabic).toContain('نصوص بلا إنجليزية أو بلا عربية: 1.');
  });

  it('lists each problem of a form that would not publish', () => {
    const error = new ApiRequestError(
      422,
      'form_package_not_publishable',
      'Not publishable',
      'r1',
      [
        {
          field: 'form.json#definition.pages[0].sections[0].fields[1]',
          code: 'duplicate_id',
          message: 'The id "customer" is used twice.',
        },
      ],
    );
    const html = render(<TemplateImportRefusal error={error} />);
    expect(html).toContain('would not publish');
    expect(html).toContain('The id &quot;customer&quot; is used twice.');
    expect(html).toContain('form.json#definition.pages[0].sections[0].fields[1]');
  });

  it('names an export after the template', () => {
    expect(packageFilename('Gas: safety')).toBe('Gas safety.integr8form');
  });
});
