// @vitest-environment jsdom
import type { FormDefinition } from '@integr8/form-engine';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftCheck } from '../api';
import { editorReducer, type EditorState, initialEditor } from '../model/editor';
import { TranslationWarning } from './changes-panel';
import { ConfigPanel } from './config-panel';
import { TranslationsPanel } from './translations-panel';

/**
 * Forms in two languages (owner's decision 2, 1.3.0): English and Arabic side
 * by side in the settings panel whatever the app's language, a Translations
 * tab listing every text, and a publish check that warns but never refuses.
 */

afterEach(() => {
  cleanup();
});

const definition = (): FormDefinition => ({
  schemaVersion: 1,
  title: { en: 'Boiler service', ar: 'صيانة الغلاية' },
  pages: [
    {
      id: 'inspection',
      title: { en: 'Inspection' },
      sections: [
        {
          id: 'appliance',
          fields: [
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result', ar: 'النتيجة' },
              help: { en: 'Pick one' },
              options: [
                { value: 'pass', label: { en: 'Pass', ar: 'ناجح' } },
                { value: 'fail', label: { en: 'Fail' } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

let latest: EditorState | undefined;

function Harness({
  locale,
  view,
  onlyMissing = false,
}: {
  locale: 'en' | 'ar';
  view: 'translations' | 'panel';
  onlyMissing?: boolean;
}) {
  const [editor, dispatch] = useReducer(editorReducer, definition(), (start) => ({
    ...initialEditor(start),
    selected: 'result',
  }));
  useEffect(() => {
    latest = editor;
  });
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: 'undo' })}>
        undo
      </button>
      {view === 'translations' ? (
        <TranslationsPanel
          definition={editor.definition}
          locale={locale}
          readOnly={false}
          dispatch={dispatch}
          onShow={() => undefined}
          initiallyOnlyMissing={onlyMissing}
        />
      ) : (
        <ConfigPanel
          definition={editor.definition}
          selected={editor.selected}
          selection={editor.selection}
          publishedIds={new Set()}
          locale={locale}
          dispatch={dispatch}
          readOnly={false}
        />
      )}
    </>
  );
}

const show = (locale: 'en' | 'ar', view: 'translations' | 'panel', onlyMissing = false) => {
  const i18n = createI18n({ locale });
  render(
    <I18nextProvider i18n={i18n}>
      <Harness locale={locale} view={view} onlyMissing={onlyMissing} />
    </I18nextProvider>,
  );
  return i18n;
};

const field = () => latest!.definition.pages[0]!.sections[0]!.fields[0]!;
const optionLabel = (index: number) => {
  const current = field();
  return current.type === 'radio' ? current.options[index]?.label : undefined;
};

describe('the settings panel', () => {
  it('edits English and Arabic side by side, whatever the app’s language', () => {
    show('en', 'panel');
    const english = screen.getByRole('textbox', { name: 'Question · English' });
    const arabic = screen.getByRole('textbox', { name: 'Question · Arabic' });
    expect((english as HTMLInputElement).value).toBe('Result');
    expect((arabic as HTMLInputElement).value).toBe('النتيجة');
    expect(arabic.getAttribute('dir')).toBe('rtl');

    fireEvent.change(arabic, { target: { value: 'نتيجة الفحص' } });
    expect(field().label).toEqual({ en: 'Result', ar: 'نتيجة الفحص' });
  });

  it('shows both languages in an Arabic app too, and edits the English', () => {
    show('ar', 'panel');
    const english = screen.getByRole('textbox', { name: 'السؤال · الإنجليزية' });
    fireEvent.change(english, { target: { value: 'Outcome' } });
    expect(field().label).toEqual({ en: 'Outcome', ar: 'النتيجة' });
  });

  it('gives every option both languages, and removes help when both are emptied', () => {
    show('en', 'panel');
    const failArabic = screen.getByRole('textbox', { name: 'Option 2 · Arabic' });
    fireEvent.change(failArabic, { target: { value: 'راسب' } });
    expect(optionLabel(1)).toEqual({
      en: 'Fail',
      ar: 'راسب',
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Help text · English' }), {
      target: { value: '' },
    });
    expect('help' in field()).toBe(false);
  });
});

describe('the Translations tab', () => {
  it('lists every text with its English and Arabic, and counts what has no Arabic', () => {
    show('en', 'translations');
    expect(screen.getByRole('status').textContent).toBe('3 texts have no Arabic');
    for (const name of [
      'Form title · English',
      'Page title · English',
      'Question · English',
      'Help text · Result · English',
      'Option · pass · Result · English',
      'Option · fail · Result · Arabic',
    ]) {
      expect(screen.getByRole('textbox', { name })).toBeDefined();
    }
  });

  it('edits the draft in place, and the edit can be undone', () => {
    show('en', 'translations');
    fireEvent.change(screen.getByRole('textbox', { name: 'Page title · Arabic' }), {
      target: { value: 'الفحص' },
    });
    expect(latest!.definition.pages[0]!.title).toEqual({ en: 'Inspection', ar: 'الفحص' });
    expect(screen.getByRole('status').textContent).toBe('2 texts have no Arabic');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    });
    expect(latest!.definition.pages[0]!.title).toEqual({ en: 'Inspection' });
  });

  it('shows only the texts with no Arabic, and keeps a row while it is filled in', () => {
    show('en', 'translations', true);
    expect(
      screen.getAllByRole('row').filter((row) => row.querySelector('input, textarea')),
    ).toHaveLength(3);
    fireEvent.change(screen.getByRole('textbox', { name: 'Option · fail · Result · Arabic' }), {
      target: { value: 'ر' },
    });
    expect(screen.getByRole('textbox', { name: 'Option · fail · Result · Arabic' })).toBeDefined();
    expect(screen.getAllByText('Done')).toHaveLength(1);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Only texts with no Arabic' }));
    expect(screen.getByRole('textbox', { name: 'Question · Arabic' })).toBeDefined();
  });

  it('removes an optional text when both languages are emptied, and keeps a required one', () => {
    show('en', 'translations');
    fireEvent.change(screen.getByRole('textbox', { name: 'Help text · Result · English' }), {
      target: { value: '' },
    });
    expect('help' in field()).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Option · fail · Result · English' }), {
      target: { value: '' },
    });
    expect(optionLabel(1)).toEqual({});
  });
});

describe('the publish check', () => {
  const check = (warnings: DraftCheck['warnings']): DraftCheck => ({
    revision: 3,
    valid: true,
    issues: [],
    diff: { titleChanged: false, changes: [], breaking: [] },
    warnings,
  });
  const missing = (path: string) => ({
    code: 'missing_translation',
    message: `${path} has no Arabic.`,
    path,
    elements: [],
    locale: 'ar',
  });

  it('warns how many texts have no Arabic, and offers the Translations tab', () => {
    const i18n = createI18n({ locale: 'en' });
    let opened = false;
    render(
      <I18nextProvider i18n={i18n}>
        <TranslationWarning
          check={check([missing('title'), missing('pages[0].title')])}
          onOpen={() => {
            opened = true;
          }}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('2 texts have no Arabic')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Open Translations' }));
    expect(opened).toBe(true);
  });

  it('says nothing when every text has Arabic', () => {
    const i18n = createI18n({ locale: 'en' });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <TranslationWarning check={check([])} onOpen={() => undefined} />
      </I18nextProvider>,
    );
    expect(container.textContent).toBe('');
  });
});
