import { describe, expect, it } from 'vitest';
import {
  answerSchemaFor,
  choiceValues,
  describeFieldType,
  FIELD_TYPES,
  type Field,
  fieldConfigIssues,
  fieldSchema,
  isAnswered,
  isCalculated,
  validateAnswer,
} from './field-types.js';
import { answer, field, MEDIA_ID, num, options, photo, plus } from './test-support/builders.js';

const codes = (target: Field, value: unknown) =>
  validateAnswer(target, value).map((error) => error.code);

describe('the registry', () => {
  it('describes every type the definition schema accepts, and nothing else', () => {
    const inSchema = fieldSchema.options.map((option) => option.shape.type.value).sort();
    expect(FIELD_TYPES.map((description) => description.type).sort()).toEqual(inSchema);
  });

  it('covers every type P06 names', () => {
    expect(FIELD_TYPES.map((description) => description.type)).toEqual(
      expect.arrayContaining([
        'text',
        'long_text',
        'number',
        'decimal',
        'date',
        'time',
        'datetime',
        'dropdown',
        'multi_select',
        'radio',
        'checkbox',
        'yes_no',
        'rating',
        'signature',
        'photo',
        'file',
        'gps',
        'barcode',
      ]),
    );
  });

  it('lets only numbers be calculated', () => {
    expect(
      FIELD_TYPES.filter((description) => description.calculable).map(
        (description) => description.type,
      ),
    ).toEqual(['number', 'decimal']);
    expect(describeFieldType('photo').valueType).toBe('opaque');
  });

  it('knows the choices a field offers', () => {
    expect(choiceValues(field('radio', 'r', { options: options('pass', 'fail') }))).toEqual([
      'pass',
      'fail',
    ]);
    expect(choiceValues(field('yes_no', 'y'))).toEqual(['yes', 'no']);
    expect(choiceValues(field('yes_no', 'y', { allowNotApplicable: true }))).toEqual([
      'yes',
      'no',
      'not_applicable',
    ]);
    expect(choiceValues(field('text', 't'))).toBeUndefined();
  });
});

describe('what counts as answered', () => {
  it.each([
    ['text', '', false],
    ['text', 'x', true],
    ['multi_select', [], false],
    ['multi_select', ['a'], true],
    ['photo', [], false],
    ['checkbox', false, true],
    ['number', 0, true],
    ['number', null, false],
  ] as const)('%s with %j: %s', (type, value, expected) => {
    expect(isAnswered(field(type, 'f'), value)).toBe(expected);
  });
});

describe('answer shapes', () => {
  it('refuses a malformed answer as invalid, before any rule', () => {
    expect(codes(field('number', 'n'), '12')).toEqual(['invalid']);
    expect(codes(field('number', 'n'), 1.5)).toEqual(['invalid']);
    expect(codes(field('checkbox', 'c'), 'true')).toEqual(['invalid']);
    expect(codes(field('photo', 'p'), photo())).toEqual(['invalid']);
    expect(
      codes(field('signature', 's'), {
        mediaId: 'not-a-uuid',
        contentType: 'image/png',
        byteSize: 1,
      }),
    ).toEqual(['invalid']);
    expect(
      answerSchemaFor(field('gps', 'g')).safeParse({ latitude: '1', longitude: '2', extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('text', () => {
  it('measures length in code points, not UTF-16 units — and says so, since that is not grapheme clusters', () => {
    const name = field('text', 'name', { maxLength: 3 });
    // Three emoji outside the BMP: six UTF-16 units, three code points.
    expect(codes(name, '😀😀😀')).toEqual([]);
    expect(codes(name, 'شريف')).toEqual(['too_long']);
    // One visible thumbs-up with a skin tone is two code points. Documented, not hidden.
    expect(codes(field('text', 'mood', { maxLength: 1 }), '👍🏽')).toEqual(['too_long']);
  });

  it('checks both ends of the length', () => {
    const code = field('text', 'code', { minLength: 2, maxLength: 4 });
    expect(validateAnswer(code, 'a')).toEqual([
      { field: 'code', code: 'too_short', params: { minimum: '2' } },
    ]);
    expect(validateAnswer(code, 'abcde')).toEqual([
      { field: 'code', code: 'too_long', params: { maximum: '4' } },
    ]);
  });

  it('applies a pattern to the whole value', () => {
    const serial = field('text', 'serial', { pattern: { source: '[A-Z]{2}\\d{4}' } });
    expect(codes(serial, 'AB1234')).toEqual([]);
    expect(codes(serial, 'xAB1234')).toEqual(['pattern_mismatch']);
    const loose = field('text', 'serial', {
      pattern: { source: '[A-Z]{2}\\d{4}', caseInsensitive: true },
    });
    expect(codes(loose, 'ab1234')).toEqual([]);
  });

  it('bounds long text and barcodes', () => {
    expect(codes(field('long_text', 'notes', { minLength: 5 }), 'hi')).toEqual(['too_short']);
    expect(codes(field('barcode', 'code', { maxLength: 3 }), '1234')).toEqual(['too_long']);
    expect(codes(field('barcode', 'code'), 'x'.repeat(1_001))).toEqual(['too_long']);
  });
});

describe('numbers', () => {
  it('bounds whole numbers', () => {
    const count = field('number', 'count', { min: 1, max: 10 });
    expect(validateAnswer(count, 0)).toEqual([
      { field: 'count', code: 'below_minimum', params: { minimum: '1' } },
    ]);
    expect(codes(count, 11)).toEqual(['above_maximum']);
    expect(codes(count, 10)).toEqual([]);
  });

  it('bounds decimals exactly, and reports the bound at the field’s own scale', () => {
    const pressure = field('decimal', 'pressure', { decimalPlaces: 2, min: '0.50', max: '10.00' });
    expect(validateAnswer(pressure, '0.49')).toEqual([
      { field: 'pressure', code: 'below_minimum', params: { minimum: '0.50' } },
    ]);
    expect(codes(pressure, '10.01')).toEqual(['above_maximum']);
    expect(codes(pressure, '10')).toEqual([]);
  });

  it('refuses more decimal places than configured, and text that is not a number', () => {
    const pressure = field('decimal', 'pressure', { decimalPlaces: 1 });
    expect(validateAnswer(pressure, '1.25')).toEqual([
      { field: 'pressure', code: 'too_many_decimal_places', params: { maximum: '1' } },
    ]);
    expect(codes(pressure, '1,5')).toEqual(['invalid']);
  });

  it('keeps a rating on its scale', () => {
    const rating = field('rating', 'rating', { scale: 5 });
    expect(validateAnswer(rating, 6)).toEqual([
      { field: 'rating', code: 'out_of_range', params: { minimum: '1', maximum: '5' } },
    ]);
    expect(codes(rating, 0)).toEqual(['out_of_range']);
    expect(codes(rating, 5)).toEqual([]);
  });
});

describe('dates and times', () => {
  it('bounds a date', () => {
    const inspected = field('date', 'inspected', { earliest: '2026-01-01', latest: '2026-12-31' });
    expect(validateAnswer(inspected, '2025-12-31')).toEqual([
      { field: 'inspected', code: 'before_earliest', params: { earliest: '2026-01-01' } },
    ]);
    expect(codes(inspected, '2027-01-01')).toEqual(['after_latest']);
    expect(codes(inspected, '2026-02-30')).toEqual(['invalid']);
  });

  it('bounds a time and a datetime, comparing instants across offsets', () => {
    expect(codes(field('time', 'arrived', { earliest: '08:00' }), '07:59')).toEqual([
      'before_earliest',
    ]);
    const logged = field('datetime', 'logged', { latest: '2026-09-13T12:00:00Z' });
    expect(codes(logged, '2026-09-13T14:30:00+03:00')).toEqual([]);
    expect(codes(logged, '2026-09-13T12:00:01Z')).toEqual(['after_latest']);
  });
});

describe('choices', () => {
  it('refuses an option the field does not offer', () => {
    expect(codes(field('dropdown', 'd', { options: options('a') }), 'b')).toEqual([
      'unknown_option',
    ]);
    expect(codes(field('yes_no', 'y'), 'not_applicable')).toEqual(['unknown_option']);
    expect(codes(field('yes_no', 'y', { allowNotApplicable: true }), 'not_applicable')).toEqual([]);
  });

  it('checks a selection: offered, not repeated, and within the counts', () => {
    const faults = field('multi_select', 'faults', {
      options: options('leak', 'noise', 'heat'),
      minSelected: 1,
      maxSelected: 2,
    });
    expect(codes(faults, ['leak', 'smell'])).toEqual(['unknown_option']);
    expect(codes(faults, ['leak', 'leak'])).toEqual(['duplicate_option']);
    expect(validateAnswer(faults, ['leak', 'noise', 'heat'])).toEqual([
      { field: 'faults', code: 'too_many_selected', params: { maximum: '2' } },
    ]);
    const atLeastTwo = field('multi_select', 'faults', {
      options: options('leak', 'noise'),
      minSelected: 2,
    });
    expect(codes(atLeastTwo, ['leak'])).toEqual(['too_few_selected']);
  });
});

describe('evidence', () => {
  it('counts files, caps their size, and accepts only images for a photo', () => {
    const evidence = field('photo', 'evidence', { minFiles: 2, maxFiles: 3, maxFileBytes: 5_000 });
    expect(codes(evidence, [photo()])).toEqual(['too_few_files']);
    expect(codes(evidence, [photo(), photo(), photo(), photo()])).toEqual(['too_many_files']);
    expect(validateAnswer(evidence, [photo(), photo(9_000)])).toEqual([
      { field: 'evidence', code: 'file_too_large', params: { maximum: '5000' } },
    ]);
    expect(codes(evidence, [photo(), photo(100, 'application/pdf')])).toEqual([
      'file_type_not_accepted',
    ]);
  });

  it('accepts exact types and wildcards for files', () => {
    const certificate = field('file', 'certificate', {
      acceptedTypes: ['application/pdf', 'image/*'],
    });
    expect(
      codes(certificate, [{ mediaId: MEDIA_ID, contentType: 'application/pdf', byteSize: 1 }]),
    ).toEqual([]);
    expect(
      codes(certificate, [{ mediaId: MEDIA_ID, contentType: 'image/heic', byteSize: 1 }]),
    ).toEqual([]);
    expect(
      codes(certificate, [{ mediaId: MEDIA_ID, contentType: 'text/plain', byteSize: 1 }]),
    ).toEqual(['file_type_not_accepted']);
    expect(
      codes(field('file', 'anything'), [
        { mediaId: MEDIA_ID, contentType: 'text/plain', byteSize: 1 },
      ]),
    ).toEqual([]);
  });

  it('needs a signature to be one media reference', () => {
    expect(codes(field('signature', 'signed'), photo())).toEqual([]);
  });
});

describe('location', () => {
  const site = field('gps', 'site', { maxAccuracyMeters: '25' });

  it('accepts a reading within range and accuracy', () => {
    expect(
      codes(site, { latitude: '30.0444', longitude: '31.2357', accuracyMeters: '8.5' }),
    ).toEqual([]);
  });

  it('refuses coordinates off the globe, or that are not numbers', () => {
    expect(codes(site, { latitude: '91', longitude: '0', accuracyMeters: '1' })).toEqual([
      'invalid',
    ]);
    expect(codes(site, { latitude: '0', longitude: '-180.1', accuracyMeters: '1' })).toEqual([
      'invalid',
    ]);
    expect(codes(site, { latitude: 'north', longitude: '0' })).toEqual(['invalid']);
    expect(codes(site, { latitude: '0', longitude: '0', accuracyMeters: 'good' })).toEqual([
      'invalid',
    ]);
  });

  it('refuses a reading that is too imprecise, or that states no accuracy at all', () => {
    expect(validateAnswer(site, { latitude: '0', longitude: '0', accuracyMeters: '40' })).toEqual([
      { field: 'site', code: 'accuracy_too_low', params: { maximum: '25' } },
    ]);
    expect(codes(site, { latitude: '0', longitude: '0' })).toEqual(['accuracy_too_low']);
    expect(codes(field('gps', 'anywhere'), { latitude: '0', longitude: '0' })).toEqual([]);
  });
});

describe('field configuration, checked at publish', () => {
  const messages = (target: Field) =>
    fieldConfigIssues(target).map((issue) => `${issue.property}: ${issue.message}`);

  it('accepts a coherent field', () => {
    expect(
      fieldConfigIssues(
        field('decimal', 'd', { decimalPlaces: 2, min: '0.00', max: '9.99', default: '1.00' }),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      field('text', 't', { minLength: 5, maxLength: 2 }),
      /minLength: minLength 5 is above maxLength 2/u,
    ],
    [field('long_text', 't', { minLength: 5, maxLength: 2 }), /minLength/u],
    [
      field('text', 't', { pattern: { source: '(a+)+' } }),
      /pattern: The pattern is not allowed: a repeated group .* \(at character 1\)/u,
    ],
    [field('number', 'n', { min: 5, max: 1 }), /min: min 5 is above max 1/u],
    [
      field('decimal', 'd', { decimalPlaces: 1, min: 'low' }),
      /min: min "low" is not a decimal number/u,
    ],
    [
      field('decimal', 'd', { decimalPlaces: 1, max: '1.25' }),
      /max: max "1.25" has more decimal places/u,
    ],
    [field('decimal', 'd', { decimalPlaces: 1, min: '5', max: '1' }), /min: min 5 is above max 1/u],
    [
      field('date', 'd', { earliest: '2026-02-30' }),
      /earliest: earliest "2026-02-30" is not a valid date/u,
    ],
    [
      field('time', 't', { earliest: '18:00', latest: '08:00' }),
      /earliest: earliest 18:00 is after latest 08:00/u,
    ],
    [
      field('datetime', 't', { latest: 'tomorrow' }),
      /latest: latest "tomorrow" is not a valid datetime/u,
    ],
    [
      field('dropdown', 'd', { options: options('a', 'a') }),
      /options: Two options share the value "a"/u,
    ],
    [field('multi_select', 'm', { minSelected: 3, maxSelected: 1 }), /minSelected/u],
    [field('photo', 'p', { minFiles: 3, maxFiles: 1 }), /minFiles/u],
    [field('gps', 'g', { maxAccuracyMeters: '0' }), /maxAccuracyMeters must be a positive/u],
    [field('gps', 'g', { maxAccuracyMeters: 'close' }), /maxAccuracyMeters must be a positive/u],
    [
      field('number', 'n', { min: 1, default: 0 }),
      /default: The default breaks the field's own rules \(below_minimum\)/u,
    ],
    [
      field('number', 'total', { calculation: plus(answer('a'), num('1')), required: true }),
      /required: A calculated field is never typed/u,
    ],
    [
      field('number', 'total', { calculation: plus(answer('a'), num('1')), default: 3 }),
      /default: A calculated field cannot also have a default/u,
    ],
  ])('refuses %j', (target, message) => {
    expect(messages(target).join('\n')).toMatch(message);
  });

  it('refuses two custom rules with the same id', () => {
    const rule = {
      id: 'same',
      assert: { kind: 'boolean' as const, value: true },
      message: { en: 'x' },
    };
    expect(messages(field('text', 't', { rules: [rule, rule] }))).toEqual([
      'rules: Two rules share the id "same"',
    ]);
  });

  it('knows which fields are calculated', () => {
    expect(isCalculated(field('number', 'n', { calculation: num('1') }))).toBe(true);
    expect(isCalculated(field('number', 'n'))).toBe(false);
    expect(isCalculated(field('text', 't'))).toBe(false);
  });
});
