import {
  addSection,
  compileDefinition,
  createFormState,
  emptyDefinition,
  type Expression,
  type Field,
  type FieldOf,
  type FormDefinition,
  type FormState,
  isEditError,
  newField,
  type Section,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuilderWorkspace, repeatableSectionFor } from './canvas';
import { VisibilityEditor } from './condition-builder';
import { ConfigPanel } from './config-panel';
import { FormRenderer } from './form-renderer';

/**
 * Repeatable sections on the builder's screens (P13b), as rendered markup: the
 * canvas marks a section that repeats, the section panel edits how, conditions
 * and calculations read across entries, and the preview fills entries in.
 *
 * This app's tests run without a DOM, so these check what each screen shows for
 * a given definition and state; what each control does to the definition is
 * held by the model's tests.
 */

const i18n = createI18n({ locale: 'en' });
const t = i18n.t.bind(i18n);
const html = (element: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
const noop = () => undefined;

const room = newField('text', 'room', { en: 'Room' });
const watts = newField('number', 'watts', { en: 'Output' });
const result: Field = {
  id: 'result',
  type: 'radio',
  label: { en: 'Result' },
  options: [
    { value: 'pass', label: { en: 'Pass' } },
    { value: 'fail', label: { en: 'Fail' } },
  ],
};
const note = newField('text', 'note', { en: 'Note' });

function survey(
  repeat: Section['repeat'] = { maxEntries: 12, entryLabel: { en: 'Radiator' } },
  summary: Field[] = [note],
): FormDefinition {
  return {
    schemaVersion: 1,
    title: { en: 'Heating survey' },
    pages: [
      {
        id: 'page_1',
        sections: [
          { id: 'radiators', title: { en: 'Radiators' }, repeat, fields: [room, watts, result] },
          { id: 'summary', fields: summary },
        ],
      },
    ],
  };
}

/** The option a `<select>` shows as chosen, by its text. */
const chosen = (markup: string) =>
  [...markup.matchAll(/<option [^>]*selected=""[^>]*>([^<]*)<\/option>/gu)].map((match) =>
    match[1]!.replaceAll('&quot;', '"'),
  );

describe('the canvas', () => {
  it('marks a repeatable section, and offers to add one that publishes as it stands', () => {
    const markup = html(
      <BuilderWorkspace
        definition={survey()}
        selected={undefined}
        locale="en"
        readOnly={false}
        dispatch={noop}
        panel={null}
        publishedIds={new Set()}
      />,
    );
    expect(markup).toContain('Repeats · up to 12');
    expect(markup).toContain('+ Add a repeatable section');

    const section = repeatableSectionFor(
      emptyDefinition({ en: 'Form' }),
      'en',
      t,
      new Set(['section']),
    );
    expect(section).toEqual({
      id: 'section_2',
      repeat: { maxEntries: 20, entryLabel: { en: 'Item' } },
      fields: [{ id: 'short_answer', type: 'text', label: { en: 'Short answer' } }],
    });
    const added = addSection(emptyDefinition({ en: 'Form' }), 'page_1', section);
    expect(!isEditError(added) && compileDefinition(added).ok).toBe(true);
  });
});

describe('the section panel', () => {
  it('shows how a repeatable section repeats, and which questions can name its entries', () => {
    const markup = html(
      <ConfigPanel
        definition={survey({
          minEntries: 1,
          maxEntries: 12,
          entryLabel: { en: 'Radiator' },
          titleField: 'room',
        })}
        selected="radiators"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(markup).toMatch(/<input type="checkbox" checked=""\/>Repeat this section/u);
    expect(markup).toContain('What one entry is called');
    expect(markup).toContain('value="Radiator"');
    expect(markup).toMatch(/Fewest entries<\/label><input[^>]*type="number"[^>]*value="1"/u);
    expect(markup).toMatch(/Most entries<\/label><input[^>]*type="number"[^>]*value="12"/u);
    expect(chosen(markup)).toContain('Room');
    expect(markup).toContain('<option value="watts">Output</option>');
    // A single choice names an entry by the words picked.
    expect(markup).toContain('<option value="result">Result</option>');
  });

  it('offers to repeat a section that does not, and nothing more until it does', () => {
    const markup = html(
      <ConfigPanel
        definition={survey()}
        selected="summary"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(markup).toMatch(/<input type="checkbox"\/>Repeat this section/u);
    expect(markup).not.toContain('Most entries');
  });
});

describe('conditions and calculations across entries', () => {
  it('reads a quantified clause back as a question, “in every entry”, a comparison and an answer', () => {
    const expression: Expression = {
      kind: 'every',
      section: 'radiators',
      condition: {
        kind: 'compare',
        operator: 'eq',
        left: { kind: 'answer', field: 'result' },
        right: { kind: 'text', value: 'pass' },
      },
    };
    const markup = html(
      <VisibilityEditor
        definition={survey()}
        elementId="note"
        expression={expression}
        locale="en"
        onChange={noop}
      />,
    );
    expect(chosen(markup)).toEqual([
      'Result (Radiators)',
      'in every entry',
      'is',
      'a value',
      'Pass',
    ]);
    expect(markup).toContain('Number of Radiators');
    expect(markup).not.toContain('Choose whether any entry or every entry must match.');
  });

  it('reads an entry-count clause back, offering only the comparisons a count allows', () => {
    const expression: Expression = {
      kind: 'compare',
      operator: 'ge',
      left: { kind: 'count', section: 'radiators' },
      right: { kind: 'number', value: '2' },
    };
    const markup = html(
      <VisibilityEditor
        definition={survey()}
        elementId="note"
        expression={expression}
        locale="en"
        onChange={noop}
      />,
    );
    expect(chosen(markup)).toEqual(['Number of Radiators', 'is at least']);
    expect(markup).toContain('inputMode="numeric"');
    expect(markup).toContain('value="2"');
    expect(markup).not.toContain('is answered');
    expect(markup).not.toContain('in any entry');
  });

  it('offers a calculation totals, extremes and counts across a repeatable section', () => {
    const total: FieldOf<'number'> = {
      id: 'total',
      type: 'number',
      label: { en: 'Total output' },
      calculation: { kind: 'aggregate', operator: 'max', section: 'radiators', field: 'watts' },
    };
    const markup = html(
      <ConfigPanel
        definition={survey(undefined, [note, total])}
        selected="total"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(chosen(markup)).toContain('Largest Output across Radiators');
    expect(markup).toContain('Number of entries in Radiators');
    expect(markup).toContain('Total of Output across Radiators');
    expect(markup).toContain('Smallest Output across Radiators');
  });
});

describe('the preview', () => {
  const compiled = (() => {
    const outcome = compileDefinition(
      survey({ minEntries: 2, maxEntries: 3, entryLabel: { en: 'Radiator' }, titleField: 'room' }),
    );
    if (!outcome.ok) {
      throw new Error('setup');
    }
    return outcome.form;
  })();

  const preview = (state: FormState) =>
    html(
      <FormRenderer
        form={compiled}
        state={state}
        view={viewForm(compiled, state)}
        onEvent={noop}
        viewport="desktop"
        locale="en"
      />,
    );

  it('opens with the entries a section needs, and fills each in on its own', () => {
    let next = 0;
    let state = createFormState(compiled, {}, { newEntryId: () => `entry-${String((next += 1))}` });
    state = transition(compiled, state, {
      type: 'answer',
      field: 'room',
      value: 'Lounge',
      entry: 'entry-1',
    }).state;

    const markup = preview(state);
    expect(markup).toContain('>Radiator 1 · Lounge</h4>');
    expect(markup).toContain('>Radiator 2</h4>');
    expect(markup).toContain('value="Lounge"');
    expect(markup).toContain('aria-label="Remove Radiator 1 · Lounge"');
    expect(markup).toContain('aria-label="Move Radiator 2 down"');
    expect(markup).toContain('+ Add Radiator');
  });

  it('shows a section short of entries beside its title once the form is checked', () => {
    let state = createFormState(compiled, { radiators: [{ id: 'a', values: { room: 'Hall' } }] });
    state = transition(compiled, state, { type: 'submit' }).state;
    const markup = preview(state);
    expect(markup).toContain('Radiators: Add at least 2.');
    // The only entry cannot go: the section needs two.
    expect(markup).toMatch(/aria-label="Remove Radiator 1 · Hall" disabled=""/u);
  });
});
