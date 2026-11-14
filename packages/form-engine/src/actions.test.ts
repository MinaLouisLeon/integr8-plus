import { describe, expect, it } from 'vitest';
import { checkFormActions, fillActionText, planFormActions, type FormAction } from './actions.js';
import {
  answer,
  answered,
  compiled,
  definition,
  eq,
  field,
  fields,
  num,
  options,
  page,
  section,
  text,
  times,
} from './test-support/builders.js';

const FOLLOW_UP = '0b8f8f7e-3c1a-4d2b-9e6f-1a2b3c4d5e6f';
const SELF = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

const trip = compiled(
  fields(
    field('decimal', 'km', { decimalPlaces: 1 }),
    field('decimal', 'mileage_total', {
      decimalPlaces: 3,
      calculation: times(answer('km'), num('2.125')),
    }),
    field('decimal', 'allowance_total', { decimalPlaces: 2 }),
    field('text', 'note'),
    field('radio', 'needs_handover', { options: options('yes', 'no') }),
  ),
);

const mileage: FormAction = {
  id: 'mileage',
  kind: 'expense_claim',
  when: answered('km'),
  category: 'Mileage',
  amount: { field: 'mileage_total' },
  description: { en: 'Mileage, {{job.reference}}', ar: 'بدل انتقال، {{job.reference}}' },
};
const allowance: FormAction = {
  id: 'allowance',
  kind: 'expense_claim',
  category: 'Allowance',
  amount: { field: 'allowance_total' },
  description: { en: 'Daily allowance' },
};
const handover: FormAction = {
  id: 'handover',
  kind: 'open_form',
  form: FOLLOW_UP,
  when: eq(answer('needs_handover'), text('yes')),
  required: false,
};

describe('checkFormActions', () => {
  it('accepts claims and a follow-up that read the form', () => {
    const result = checkFormActions([mileage, allowance, handover], trip, { formId: SELF });
    expect(result.ok).toBe(true);
  });

  it('accepts no actions', () => {
    expect(checkFormActions([], trip).ok).toBe(true);
  });

  it('refuses an unknown kind or key', () => {
    const result = checkFormActions([{ ...allowance, kind: 'webhook' }], trip);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]?.code).toBe('invalid_actions');
    const extra = checkFormActions([{ ...allowance, rate: 3 }], trip);
    expect(!extra.ok && extra.issues[0]?.code).toBe('invalid_actions');
  });

  it('refuses more than ten actions', () => {
    const many = Array.from({ length: 11 }, (_, n) => ({ ...allowance, id: `a${String(n)}` }));
    expect(checkFormActions(many, trip).ok).toBe(false);
  });

  it('names each problem with its action', () => {
    const result = checkFormActions(
      [
        allowance,
        { ...allowance, amount: { field: 'note' } },
        { ...mileage, id: 'ghost', amount: { field: 'nowhere' } },
        { ...mileage, id: 'bad_text', description: { en: 'For {{customer.name}}' } },
        { ...handover, id: 'loop', form: SELF },
        { ...handover, id: 'bad_when', when: answer('km') },
      ],
      trip,
      { formId: SELF },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => [issue.code, issue.action])).toEqual([
      ['duplicate_action_id', 'allowance'],
      ['not_a_number', 'allowance'],
      ['unknown_field', 'ghost'],
      ['unknown_placeholder', 'bad_text'],
      ['opens_itself', 'loop'],
      ['invalid_condition', 'bad_when'],
    ]);
  });

  it('refuses an amount inside a repeating section', () => {
    const repeating = compiled(
      definition([
        page('p', [
          section('days', [field('decimal', 'day_amount', { decimalPlaces: 2 })], {
            repeat: { maxEntries: 5, entryLabel: { en: 'Day' } },
          }),
        ]),
      ]),
    );
    const result = checkFormActions([{ ...allowance, amount: { field: 'day_amount' } }], repeating);
    expect(!result.ok && result.issues[0]?.code).toBe('inside_repeat');
  });
});

describe('planFormActions', () => {
  const actions = [mileage, allowance, handover];

  it('works out each amount from the answers, calculations included, to piastres', () => {
    const plan = planFormActions(trip, actions, {
      km: '57.5',
      allowance_total: '150',
      needs_handover: 'yes',
    });
    expect(
      plan.map((step) => ({
        id: step.action.id,
        due: step.due,
        amount: 'amount' in step ? step.amount : undefined,
      })),
    ).toEqual([
      // 57.5 × 2.125 = 122.1875, rounded half away from zero.
      { id: 'mileage', due: true, amount: '122.19' },
      { id: 'allowance', due: true, amount: '150.00' },
      { id: 'handover', due: true, amount: undefined },
    ]);
  });

  it('skips a claim whose condition does not hold, or that has no amount', () => {
    const plan = planFormActions(trip, actions, { allowance_total: '0', needs_handover: 'no' });
    expect(plan).toEqual([
      { action: mileage, due: false, because: 'condition' },
      { action: allowance, due: false, because: 'no_amount' },
      { action: handover, due: false, because: 'condition' },
    ]);
  });

  it('treats an unknown condition as not holding', () => {
    const plan = planFormActions(trip, [handover], {});
    expect(plan[0]?.due).toBe(false);
  });

  it('rounds to the scale it is given', () => {
    const plan = planFormActions(trip, [mileage], { km: '1' }, { scale: 3 });
    expect(plan[0]).toMatchObject({ due: true, amount: '2.125' });
  });
});

describe('fillActionText', () => {
  it('fills placeholders in the chosen language, falling back to English', () => {
    const description = { en: 'Mileage, {{job.reference}}', ar: 'بدل انتقال، {{job.reference}}' };
    expect(fillActionText(description, 'ar', { 'job.reference': 'WO-000042' })).toBe(
      'بدل انتقال، WO-000042',
    );
    expect(fillActionText(description, 'fr', { 'job.reference': 'WO-000042' })).toBe(
      'Mileage, WO-000042',
    );
  });

  it('reads a missing value as nothing and closes the gap', () => {
    expect(fillActionText({ en: 'Trip {{job.reference}} done' }, 'en', {})).toBe('Trip done');
  });
});
