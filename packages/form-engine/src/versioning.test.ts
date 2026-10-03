import { describe, expect, it } from 'vitest';
import { answer, compiled, field, fields, num, options, plus } from './test-support/builders.js';
import { migrateAnswers, prepareForPublish } from './versioning.js';

describe('prepareForPublish', () => {
  it('is the compiler, under the name that matters at publish time', () => {
    expect(prepareForPublish(fields(field('text', 't'))).ok).toBe(true);
    expect(prepareForPublish({}).ok).toBe(false);
  });
});

describe('moving a draft to a newer version', () => {
  const version3 = compiled(
    fields(
      field('text', 'site_contact'),
      field('text', 'delay_reason'),
      field('number', 'readings', { max: 100 }),
      field('radio', 'result', { options: options('pass', 'fail', 'deferred') }),
      field('multi_select', 'faults', { options: options('leak', 'noise', 'heat') }),
      field('multi_select', 'parts', { options: options('seal', 'valve') }),
      field('date', 'next_visit'),
      field('number', 'hours'),
      field('text', 'constructor'),
    ),
  );

  const version4 = compiled(
    fields(
      field('text', 'site_contact'), // unchanged
      // delay_reason removed
      field('number', 'readings', { max: 10 }), // tighter limit
      field('radio', 'result', { options: options('pass', 'fail') }), // "deferred" removed
      field('multi_select', 'faults', { options: options('leak', 'heat', 'smell') }), // "noise" removed
      field('multi_select', 'parts', { options: options('gasket') }), // every chosen option removed
      field('time', 'next_visit'), // type changed
      field('number', 'hours', { calculation: plus(answer('readings'), num('0')) }), // now calculated
      field('text', 'constructor'),
    ),
  );

  const draft = {
    site_contact: 'Dana',
    delay_reason: 'Access',
    readings: 40,
    result: 'deferred',
    faults: ['leak', 'noise'],
    parts: ['seal'],
    next_visit: '2026-10-01',
    hours: 3,
  };

  const migration = migrateAnswers(version3, version4, draft);

  it('carries what still fits, in the new reading order', () => {
    expect(migration.answers).toEqual({ site_contact: 'Dana', readings: 40, faults: ['leak'] });
    expect(migration.carried).toEqual(['site_contact', 'readings', 'faults']);
  });

  it('says what was dropped, and why', () => {
    expect(migration.dropped).toEqual([
      { field: 'delay_reason', reason: 'field_removed' },
      { field: 'result', reason: 'option_removed' },
      { field: 'parts', reason: 'option_removed' },
      { field: 'next_visit', reason: 'type_changed' },
      { field: 'hours', reason: 'now_calculated' },
    ]);
  });

  it('keeps a multi-select with its surviving options, and says which were removed', () => {
    expect(migration.trimmed).toEqual([{ field: 'faults', removed: ['noise'] }]);
  });

  it('keeps a value the new rules reject, and flags it, rather than blanking it silently', () => {
    expect(migration.nowInvalid).toEqual(['readings']);
  });

  it('does not invent an answer for a field that was never answered — even one named constructor', () => {
    expect(migration.dropped.map((entry) => entry.field)).not.toContain('constructor');
    expect(migration.answers).not.toHaveProperty('constructor');
  });

  it('carries everything when nothing changed', () => {
    const same = migrateAnswers(version3, version3, draft);
    expect(same.answers).toEqual(draft);
    expect(same.dropped).toEqual([]);
  });

  it('drops a value whose shape the new field cannot hold even when the type name matches', () => {
    const before = compiled(fields(field('text', 'note')));
    expect(migrateAnswers(before, before, { note: 42 }).dropped).toEqual([
      { field: 'note', reason: 'type_changed' },
    ]);
  });
});
