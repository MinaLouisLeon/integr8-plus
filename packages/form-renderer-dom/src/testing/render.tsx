import {
  type Field,
  compileDefinition,
  type CompiledForm,
  type FormDefinition,
} from '@integr8/form-engine';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { render, type RenderResult } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { MediaAdapter } from '../media.js';

export function compile(definition: FormDefinition): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join('\n'));
  }
  return result.form;
}

export function formOf(pages: Field[][], title = 'Test form'): CompiledForm {
  return compile({
    schemaVersion: 1,
    title: { en: title },
    pages: pages.map((fields, index) => ({
      id: `page_${String(index + 1)}`,
      sections: [{ id: `section_${String(index + 1)}`, fields }],
    })),
  });
}

export function renderWithI18n(element: ReactElement): RenderResult {
  const i18n = createI18n({ locale: 'en' });
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

let nextMedia = 0;

export function memoryMedia(): MediaAdapter & { upload: ReturnType<typeof vi.fn> } {
  return {
    upload: vi.fn(
      (file: Blob, options: { contentType: string; onProgress?: (fraction: number) => void }) => {
        options.onProgress?.(1);
        nextMedia += 1;
        return Promise.resolve({
          mediaId: `00000000-0000-4000-8000-${String(nextMedia).padStart(12, '0')}`,
          contentType: options.contentType,
          byteSize: file.size,
        });
      },
    ),
    url: (reference) => Promise.resolve(`https://media.test/${reference.mediaId}`),
  };
}

/**
 * Accessibility violations axe can find in a document fragment.
 *
 * Colour contrast is off because jsdom computes no styles; everything else —
 * names, roles, labels, ARIA validity, duplicate ids — is checked.
 */
export async function accessibilityViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}
