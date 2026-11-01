import {
  type Expression,
  FIELD_TYPES,
  isInformation,
  isQuestion,
  VERSION_2_EXPRESSION_KINDS,
  viewForm,
  visit,
} from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOUR_TODAY,
  behaviourCases,
  EVERYTHING_FORM,
  expectedScreen,
  stateOf,
  type Translate,
} from './index.js';

/**
 * The behaviour check's own ground: the forms and steps it drives every
 * renderer through really do cover what they claim to. The comparisons
 * themselves run in each renderer's package.
 */

const translate: Translate = (key, params) =>
  `${key}${Object.keys(params).length === 0 ? '' : JSON.stringify(params)}`;

const cases = behaviourCases();

describe('the every-type form', () => {
  const items = EVERYTHING_FORM.pages.flatMap((page) =>
    page.sections.flatMap((section) => section.fields),
  );
  const fields = items.filter(isQuestion);
  const blocks = items.filter(isInformation);
  const expressions: Expression[] = [
    ...EVERYTHING_FORM.pages.flatMap((page) => [
      ...(page.visibleWhen === undefined ? [] : [page.visibleWhen]),
      ...page.sections.flatMap((section) =>
        section.visibleWhen === undefined ? [] : [section.visibleWhen],
      ),
    ]),
    ...fields.flatMap((field) => [
      ...(field.visibleWhen === undefined ? [] : [field.visibleWhen]),
      ...(field.requiredWhen === undefined ? [] : [field.requiredWhen]),
      ...(field.rules ?? []).map((rule) => rule.assert),
      ...('calculation' in field && field.calculation !== undefined ? [field.calculation] : []),
    ]),
  ];
  const kinds = new Set<Expression['kind']>();
  for (const expression of expressions) {
    visit(expression, (node) => kinds.add(node.kind));
  }

  it('asks every type of question there is', () => {
    expect(new Set(fields.map((field) => field.type))).toEqual(
      new Set(FIELD_TYPES.map((entry) => entry.type)),
    );
  });

  it('uses every kind of rule', () => {
    const pages = EVERYTHING_FORM.pages;
    expect(pages.some((page) => page.visibleWhen !== undefined)).toBe(true);
    expect(pages.some((page) => page.sections.some((s) => s.visibleWhen !== undefined))).toBe(true);
    expect(fields.some((field) => field.visibleWhen !== undefined)).toBe(true);
    expect(fields.some((field) => field.requiredWhen !== undefined)).toBe(true);
    expect(fields.some((field) => 'dependsOn' in field && field.dependsOn !== undefined)).toBe(
      true,
    );
    expect(fields.some((field) => (field.rules ?? []).length > 0)).toBe(true);
    expect(fields.some((field) => field.type === 'text' && field.pattern?.message)).toBe(true);
    const repeat = pages.flatMap((page) => page.sections).find((s) => s.repeat !== undefined);
    expect(repeat?.repeat).toMatchObject({ minEntries: 1, titleField: 'room' });
    expect([...kinds]).toEqual(
      expect.arrayContaining(['arithmetic', 'aggregate', 'count', 'every', 'answered', 'compare']),
    );
  });

  it('uses what form format 2 added: descriptions, Information blocks and the new calculations', () => {
    expect(EVERYTHING_FORM.schemaVersion).toBe(2);
    const pages = EVERYTHING_FORM.pages;
    expect(pages.some((page) => page.description !== undefined)).toBe(true);
    expect(pages.some((page) => page.sections.some((s) => s.description !== undefined))).toBe(true);
    expect(new Set(blocks.map((block) => block.style ?? 'plain'))).toEqual(
      new Set(['plain', 'tip', 'warning']),
    );
    expect(blocks.some((block) => block.visibleWhen !== undefined)).toBe(true);
    expect(blocks.some((block) => block.heading === undefined)).toBe(true);
    const repeat = pages.flatMap((page) => page.sections).find((s) => s.repeat !== undefined);
    expect(repeat?.fields.some(isInformation)).toBe(true);
    // Every new family except `now`, which reads the clock and so cannot be compared.
    expect([...kinds].filter((kind) => VERSION_2_EXPRESSION_KINDS.has(kind)).sort()).toEqual([
      'difference',
      'percentage',
      'round',
      'shift_date',
      'statistic',
    ]);
    expect(fields.some((field) => field.type === 'date' && 'calculation' in field)).toBe(true);
  });
});

describe('the cases', () => {
  it('are the six library forms and the every-type form', () => {
    expect(cases.map((entry) => entry.key)).toHaveLength(7);
    expect(cases.at(-1)?.key).toBe('everything');
  });

  it.each(cases.map((entry) => [entry.key, entry] as const))(
    '%s: steps change what is shown, and Review shows errors',
    (_key, { form, steps }) => {
      const screens = steps.map((step) =>
        expectedScreen(
          form,
          viewForm(form, stateOf(form, step), { today: BEHAVIOUR_TODAY }),
          'en',
          translate,
        ),
      );
      const [opened, reviewed] = screens;
      expect(opened!.questions.every((question) => question.errors.length === 0)).toBe(true);
      expect(reviewed!.questions.some((question) => question.errors.length > 0)).toBe(true);
      expect(new Set(screens.map((screen) => JSON.stringify(screen))).size).toBeGreaterThan(1);
    },
  );

  it('reach entries, required-only-when and a custom message in the every-type form', () => {
    const everything = cases.at(-1)!;
    const all = everything.steps.map((step) =>
      expectedScreen(
        everything.form,
        viewForm(everything.form, stateOf(everything.form, step), { today: BEHAVIOUR_TODAY }),
        'ar',
        translate,
      ),
    );
    const questions = all.flatMap((screen) => screen.questions);
    expect(questions.some((question) => question.entry === 'radiators-2')).toBe(true);
    expect(questions.some((question) => question.id === 'reason' && question.required)).toBe(true);
    expect(questions.some((question) => question.errors.includes('لا تأخذ أكثر من 8 قراءات'))).toBe(
      true,
    );
    expect(questions.some((question) => question.errors.includes('افحص مشعين على الأقل'))).toBe(
      true,
    );
    expect(all.some((screen) => screen.sections.some((s) => s.id === 'failure_detail'))).toBe(true);
    expect(all.some((screen) => !screen.sections.some((s) => s.id === 'captured'))).toBe(true);
  });

  it('show descriptions, Information blocks and worked-out answers in the every-type form', () => {
    const everything = cases.at(-1)!;
    const all = everything.steps.map((step) =>
      expectedScreen(
        everything.form,
        viewForm(everything.form, stateOf(everything.form, step), { today: BEHAVIOUR_TODAY }),
        'en',
        translate,
      ),
    );
    const opened = all[0]!;
    expect(opened.pages[0]).toEqual({
      id: 'basics',
      description: 'What the unit is and when it was seen. Answer from its plate.',
    });
    expect(opened.sections.find((s) => s.id === 'typed')?.description).toBe('Copy them exactly.');
    expect(opened.information.map((block) => block.id)).toEqual(['plate_tip', 'about_dates']);
    const information = all.flatMap((screen) => screen.information);
    expect(information).toContainEqual(
      expect.objectContaining({ id: 'fail_warning', style: 'warning' }),
    );
    expect(information).toContainEqual(
      expect.objectContaining({ id: 'bleed_tip', entry: 'radiators-1', style: 'tip' }),
    );
    const filled = all[2]!.questions;
    const value = (id: string) => filled.find((question) => question.id === id)?.value;
    // Visited 1 September; "today" is 13 September.
    expect(value('days_since_visit')).toBe('12');
    expect(value('next_service')).toBe('Mar 1, 2027');
    expect(value('pressure_rounded')).toBe('0 bar');
    expect(value('readings_share')).toBe('12.5 %');
    expect(opened.questions.find((question) => question.id === 'next_service')?.value).toBe('—');
  });
});
