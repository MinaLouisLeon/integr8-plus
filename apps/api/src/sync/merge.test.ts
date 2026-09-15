import { describe, expect, it } from 'vitest';
import { mergeRecords, sameValue } from './merge.js';

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
