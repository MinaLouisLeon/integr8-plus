import {
  compileDefinition,
  createFormState,
  type Field,
  type FormDefinition,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fieldRuleSentences } from '../model/sentences';
import { BuilderWorkspace } from './canvas';
import { ConfigPanel, dependencyCandidates } from './config-panel';
import { FormRenderer } from './form-renderer';

/**
 * Required only when, dependent choices, and conditions read out on the canvas:
 * what the builder's screens show for a definition that uses them.
 */

const i18n = createI18n({ locale: 'en' });
const t = i18n.t.bind(i18n);
const html = (element: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
const noop = () => undefined;

const result: Field = {
  id: 'result',
  type: 'radio',
  label: { en: 'Result' },
  required: true,
  options: [
    { value: 'pass', label: { en: 'Pass' } },
    { value: 'fail', label: { en: 'Fail' } },
  ],
};
const hazards: Field = {
  id: 'hazards',
  type: 'multi_select',
  label: { en: 'Hazards' },
  options: [
    { value: 'gas', label: { en: 'Gas' } },
    { value: 'height', label: { en: 'Working at height' } },
  ],
};
const reason: Field = {
  id: 'reason',
  type: 'long_text',
  label: { en: 'Reason' },
  visibleWhen: {
    kind: 'compare',
    operator: 'eq',
    left: { kind: 'answer', field: 'result' },
    right: { kind: 'text', value: 'fail' },
  },
  requiredWhen: {
    kind: 'any',
    operands: [
      { kind: 'includes', field: 'hazards', option: 'gas' },
      { kind: 'not', operand: { kind: 'answered', field: 'hazards' } },
    ],
  },
};
const ppe: Field = {
  id: 'ppe',
  type: 'dropdown',
  label: { en: 'Protection' },
  options: [
    { value: 'mask', label: { en: 'Mask' } },
    { value: 'harness', label: { en: 'Harness' } },
  ],
  dependsOn: { field: 'hazards', options: { mask: ['gas'], harness: ['height'] } },
};
const handwritten: Field = {
  id: 'handwritten',
  type: 'text',
  label: { en: 'Handwritten' },
  visibleWhen: {
    kind: 'compare',
    operator: 'eq',
    left: {
      kind: 'arithmetic',
      operator: 'add',
      left: { kind: 'number', value: '1' },
      right: { kind: 'number', value: '1' },
    },
    right: { kind: 'number', value: '2' },
  },
};

const definition: FormDefinition = {
  schemaVersion: 1,
  title: { en: 'Site safety' },
  pages: [
    {
      id: 'page_1',
      sections: [{ id: 'section_1', fields: [result, hazards, reason, ppe, handwritten] }],
    },
  ],
};

describe('rules as sentences', () => {
  it('reads a question’s conditions out the way the builder would phrase them', () => {
    expect(fieldRuleSentences(reason, definition, 'en', t)).toEqual([
      'Shown when Result is Fail',
      'Required when Hazards includes Gas or Hazards is not answered',
    ]);
    expect(fieldRuleSentences(ppe, definition, 'en', t)).toEqual(['Choices depend on Hazards']);
    expect(fieldRuleSentences(result, definition, 'en', t)).toEqual([]);
  });

  it('names a rule it cannot phrase rather than guessing at it', () => {
    expect(fieldRuleSentences(handwritten, definition, 'en', t)).toEqual([
      'Shown when a rule written outside the builder',
    ]);
  });

  it('says nothing about "required when" on a question that is always required', () => {
    expect(fieldRuleSentences({ ...reason, required: true }, definition, 'en', t)).toEqual([
      'Shown when Result is Fail',
    ]);
  });
});

describe('the canvas', () => {
  it('shows each question’s rules on its card, with a way to change when it is shown', () => {
    const markup = html(
      <BuilderWorkspace
        definition={definition}
        selected={undefined}
        locale="en"
        readOnly={false}
        dispatch={noop}
        panel={null}
        publishedIds={new Set()}
      />,
    );
    expect(markup).toContain('Shown when Result is Fail');
    expect(markup).toContain('Required when Hazards includes Gas or Hazards is not answered');
    expect(markup).toContain('Choices depend on Hazards');
    expect(markup.match(/Show when…/gu)).toHaveLength(5);
    expect(markup).not.toContain('Shown only sometimes');
  });
});

describe('the question panel', () => {
  it('offers "required only when" as a rule, greyed out while the question is always required', () => {
    const optional = html(
      <ConfigPanel
        definition={definition}
        selected="reason"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(optional).toContain('When it must be answered');
    expect(optional).toContain('Required when');
    expect(optional).not.toContain('Always required.');

    const fixed = html(
      <ConfigPanel
        definition={definition}
        selected="result"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(fixed).toContain('Always required.');
    expect(fixed).toMatch(/<fieldset disabled=""[^>]*>.*Optional/u);
  });

  it('lists the choice questions a dependent list may follow, and the parent’s options per option', () => {
    expect(dependencyCandidates(definition, 'ppe').map((field) => field.id)).toEqual([
      'result',
      'hazards',
    ]);
    const markup = html(
      <ConfigPanel
        definition={definition}
        selected="ppe"
        selection={0}
        publishedIds={new Set()}
        locale="en"
        dispatch={noop}
        readOnly={false}
      />,
    );
    expect(markup).toContain('<option value="">Nothing — offer every option</option>');
    expect(markup).toContain('<option value="hazards" selected="">Hazards</option>');
    expect(markup).toContain('Offer “Mask” when Hazards is');
    expect(markup).toMatch(/<input type="checkbox" checked=""\/>Gas/u);
    expect(markup).toMatch(/<input type="checkbox"\/>Working at height/u);
  });
});

describe('the preview', () => {
  it('marks a question required as the rule says, and offers only the choices revealed', () => {
    const compiled = compileDefinition(definition);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    const form = compiled.form;
    let state = createFormState(form);
    state = transition(form, state, { type: 'answer', field: 'result', value: 'fail' }).state;
    const blank = html(
      <FormRenderer
        form={form}
        state={state}
        view={viewForm(form, state)}
        onEvent={noop}
        viewport="desktop"
        locale="en"
      />,
    );
    // Hazards is unanswered: Reason is required, and Protection offers nothing yet.
    expect(blank).toMatch(/Reason<span aria-hidden="true"[^>]*> \*<\/span>/u);
    expect(blank).toContain('Choose “Hazards” first.');
    expect(blank).not.toContain('<option value="mask">');

    state = transition(form, state, { type: 'answer', field: 'hazards', value: ['height'] }).state;
    const answered = html(
      <FormRenderer
        form={form}
        state={state}
        view={viewForm(form, state)}
        onEvent={noop}
        viewport="desktop"
        locale="en"
      />,
    );
    expect(answered).not.toMatch(/Reason<span aria-hidden="true"[^>]*> \*<\/span>/u);
    expect(answered).toContain('<option value="harness">Harness</option>');
    expect(answered).not.toContain('<option value="mask">');
  });
});
