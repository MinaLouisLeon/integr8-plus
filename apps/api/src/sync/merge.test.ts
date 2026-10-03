import { describe, expect, it } from 'vitest';
import { mergeAnswers, mergeRecords, sameValue } from './merge.js';

describe('three-way merge', () => {
  it('takes my change where only I changed a key, and keeps theirs where only they did', () => {
    const result = mergeRecords<Record<string, unknown>>(
      { pressure: '18', result: null, note: 'ok' },
      { pressure: '21', result: null, note: 'ok' },
      { pressure: '18', result: 'safe', note: 'ok' },
    );
    expect(result).toEqual({
      outcome: 'merged',
      value: { pressure: '21', result: 'safe', note: 'ok' },
      changed: true,
    });
  });

  it('agrees when both changed a key to the same value', () => {
    expect(
      mergeRecords<Record<string, unknown>>({ done: false }, { done: true }, { done: true }),
    ).toEqual({
      outcome: 'merged',
      value: { done: true },
      changed: false,
    });
  });

  it('refuses to guess when both changed a key differently, and names both versions', () => {
    expect(
      mergeRecords<Record<string, unknown>>(
        { gateCode: '4471#', parking: 'Rear' },
        { gateCode: '9911#', parking: 'Rear' },
        { gateCode: '1234#', parking: 'Front' },
      ),
    ).toEqual({
      outcome: 'conflict',
      conflicts: [{ key: 'gateCode', base: '4471#', mine: '9911#', theirs: '1234#' }],
    });
  });

  it('treats a cleared value, an absent key and null as the same, and removes a cleared key', () => {
    const result = mergeRecords<Record<string, unknown>>(
      { note: 'x', photos: [] },
      { photos: [] },
      { note: 'x', photos: [] },
    );
    expect(result).toEqual({ outcome: 'merged', value: { photos: [] }, changed: true });
    expect(mergeRecords<Record<string, unknown>>({ a: null }, {}, { a: undefined })).toMatchObject({
      outcome: 'merged',
      changed: false,
    });
  });

  it('compares answers deeply, ignoring key order', () => {
    expect(sameValue({ mediaId: 'm', byteSize: 3 }, { byteSize: 3, mediaId: 'm' })).toBe(true);
    expect(sameValue([{ a: 1 }], [{ a: 2 }])).toBe(false);
    expect(
      mergeRecords<Record<string, unknown>>(
        { photos: [{ mediaId: 'a' }] },
        { photos: [{ mediaId: 'a' }, { mediaId: 'b' }] },
        { photos: [{ mediaId: 'a' }] },
      ),
    ).toMatchObject({ outcome: 'merged', value: { photos: [{ mediaId: 'a' }, { mediaId: 'b' }] } });
  });
});

describe('merging entries of a repeatable section (P13b)', () => {
  const entry = (id: string, values: Record<string, unknown>) => ({ id, values });
  const base = {
    site: 'Mill Lane',
    appliances: [entry('boiler', { make: 'Worcester' }), entry('fire', { make: 'Baxi' })],
  };

  it('keeps an appliance added on each phone, and answers changed in different entries', () => {
    const mine = {
      ...base,
      appliances: [
        entry('boiler', { make: 'Worcester', flue: 'yes' }),
        entry('cooker', { make: 'Belling' }),
        entry('fire', { make: 'Baxi' }),
      ],
    };
    const theirs = {
      ...base,
      appliances: [
        entry('boiler', { make: 'Worcester' }),
        entry('fire', { make: 'Baxi', flue: 'no' }),
        entry('hob', { make: 'Neff' }),
      ],
    };
    expect(mergeAnswers(base, mine, theirs)).toEqual({
      outcome: 'merged',
      changed: true,
      value: {
        site: 'Mill Lane',
        appliances: [
          entry('boiler', { make: 'Worcester', flue: 'yes' }),
          entry('cooker', { make: 'Belling' }),
          entry('fire', { make: 'Baxi', flue: 'no' }),
          entry('hob', { make: 'Neff' }),
        ],
      },
    });
  });

  it('removes an entry removed on one side, unless the other side changed it, which is for a person to decide', () => {
    const removed = { ...base, appliances: [entry('boiler', { make: 'Worcester' })] };
    expect(mergeAnswers(base, removed, base)).toMatchObject({
      outcome: 'merged',
      value: { appliances: [entry('boiler', { make: 'Worcester' })] },
    });
    const edited = {
      ...base,
      appliances: [entry('boiler', { make: 'Worcester' }), entry('fire', { make: 'Valor' })],
    };
    expect(mergeAnswers(base, removed, edited)).toMatchObject({
      outcome: 'conflict',
      conflicts: [{ key: 'appliances' }],
    });
  });

  it('conflicts on the section when one entry’s answer changed both ways, and still merges plain answers', () => {
    const mine = {
      site: 'Mill Lane, rear',
      appliances: [entry('boiler', { make: 'Ideal' }), entry('fire', { make: 'Baxi' })],
    };
    const theirs = {
      ...base,
      appliances: [entry('boiler', { make: 'Vaillant' }), entry('fire', { make: 'Baxi' })],
    };
    expect(mergeAnswers(base, mine, theirs)).toMatchObject({
      outcome: 'conflict',
      conflicts: [{ key: 'appliances', mine: mine.appliances, theirs: theirs.appliances }],
    });
    expect(mergeAnswers(base, { ...base, site: 'Rear' }, { ...base, appliances: [] })).toEqual({
      outcome: 'merged',
      changed: true,
      value: { site: 'Rear' },
    });
  });
});
