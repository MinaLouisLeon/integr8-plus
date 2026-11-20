import { describe, expect, it } from 'vitest';
import { freeTwinSlug, remapActions, twinEmail } from './test-twin.js';

describe('freeTwinSlug', () => {
  it('takes <slug>-twin, then numbers', async () => {
    const taken = new Set(['acme-twin', 'acme-twin-2']);
    expect(await freeTwinSlug('acme', (slug) => Promise.resolve(taken.has(slug)))).toBe(
      'acme-twin-3',
    );
    expect(await freeTwinSlug('acme', () => Promise.resolve(false))).toBe('acme-twin');
  });

  it('cuts a long slug so the whole fits in 63 characters', async () => {
    const long = `${'a'.repeat(58)}-bcdef`;
    const slug = await freeTwinSlug(long, () => Promise.resolve(false));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-twin')).toBe(true);
    expect(slug).not.toContain('--');
  });
});

describe('remapActions', () => {
  const a = '00000000-0000-4000-8000-00000000000a';
  const b = '00000000-0000-4000-8000-00000000000b';
  const newA = '00000000-0000-4000-8000-0000000000aa';

  it('points open_form at the copied form and keeps other actions as they are', () => {
    const claim = { id: 'claim', kind: 'expense_claim', category: 'Fuel', amount: { field: 'km' } };
    const result = remapActions(
      [claim, { id: 'next', kind: 'open_form', form: a, required: true }],
      new Map([[a, newA]]),
    );
    expect(result).toEqual({
      actions: [claim, { id: 'next', kind: 'open_form', form: newA, required: true }],
      dropped: 0,
    });
  });

  it('leaves out an open_form whose form was not copied', () => {
    const result = remapActions(
      [{ id: 'next', kind: 'open_form', form: b, required: false }],
      new Map([[a, newA]]),
    );
    expect(result).toEqual({ actions: [], dropped: 1 });
  });
});

describe('twinEmail', () => {
  it('is under example.com, which never receives mail', () => {
    expect(twinEmail('hr_manager', 'acme-twin')).toBe('hr.manager@acme-twin.test-twin.example.com');
  });
});
