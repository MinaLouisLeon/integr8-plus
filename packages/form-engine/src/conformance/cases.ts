import type { FormEvent } from '../state.js';
import type { EvaluationContext } from '../evaluate.js';

/**
 * The conformance corpus.
 *
 * Every case is a definition, a context, and a sequence of things a person
 * does. The runner records what the engine decides after each step. The whole
 * record is written once, in Node, to `conformance/golden.jsonl`, and every
 * other runtime must reproduce it byte for byte.
 *
 * Cases are chosen for where two JavaScript engines are most likely to part
 * ways, not for coverage — coverage is the unit tests' job:
 *
 * - decimal arithmetic and half-away-from-zero rounding at every sign
 * - calendar arithmetic around leap days, and instants across UTC offsets
 * - string length in code points, for Arabic and for emoji
 * - regular expressions, including case-insensitive matching
 * - three-valued logic and cascading visibility
 * - key order in objects built along different paths
 * - the exact wording of every publish-time error
 * - entries of a repeatable section: rules inside one entry and across all of
 *   them, adding, removing and reordering, and what the server refuses (P13b)
 * - a field required only when another answer says so, and choices that depend
 *   on another answer: what is offered, what is refused, and the publish errors
 *
 * Plain object literals only: this file is bundled into the Hermes run.
 */

export interface ConformanceCase {
  name: string;
  definition: unknown;
  context?: EvaluationContext;
  steps?: FormEvent[];
  /** Submitted as-is to `validateSubmission`, as a server would receive it. */
  submission?: unknown;
  /** A second definition to migrate the final answers to. */
  migrateTo?: unknown;
}

const l = (en: string, ar?: string) => (ar === undefined ? { en } : { en, ar });
const opts = (...values: string[]) => values.map((value) => ({ value, label: l(value) }));
const form = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  title: l('Conformance'),
  pages: [{ id: 'page_1', sections: [{ id: 'section_1', fields, ...extra }] }],
});
const answer = (field: string) => ({ kind: 'answer', field });
const answered = (field: string) => ({ kind: 'answered', field });
const includes = (field: string, option: string) => ({ kind: 'includes', field, option });
const num = (value: string) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const cmp = (operator: string, left: unknown, right: unknown) => ({
  kind: 'compare',
  operator,
  left,
  right,
});
const math = (operator: string, left: unknown, right: unknown) => ({
  kind: 'arithmetic',
  operator,
  left,
  right,
});
const set = (field: string, value: unknown): FormEvent => ({ type: 'answer', field, value });
const setIn = (entry: string, field: string, value: unknown): FormEvent => ({
  type: 'answer',
  field,
  value,
  entry,
});
const addEntry = (section: string, entry: string, index?: number): FormEvent =>
  index === undefined
    ? { type: 'add_entry', section, entry }
    : { type: 'add_entry', section, entry, index };
const count = (section: string) => ({ kind: 'count', section });
const total = (operator: string, section: string, field: string) => ({
  kind: 'aggregate',
  operator,
  section,
  field,
});
const some = (section: string, condition: unknown) => ({ kind: 'some', section, condition });
const every = (section: string, condition: unknown) => ({ kind: 'every', section, condition });
const appliances = (extra: Record<string, unknown> = {}) => ({
  id: 'appliances',
  title: l('Appliances'),
  repeat: {
    minEntries: 1,
    maxEntries: 3,
    entryLabel: l('Appliance', 'جهاز'),
    titleField: 'make',
  },
  fields: [
    { id: 'make', type: 'text', label: l('Make'), required: true },
    { id: 'kind', type: 'radio', label: l('Kind'), options: opts('gas', 'electric') },
    {
      id: 'flue_ok',
      type: 'yes_no',
      label: l('Flue safe'),
      required: true,
      visibleWhen: cmp('eq', answer('kind'), text('gas')),
    },
    {
      id: 'landlord_ref',
      type: 'text',
      label: l('Landlord reference'),
      visibleWhen: cmp('eq', answer('property'), text('rental')),
    },
    {
      id: 'rating_kw',
      type: 'decimal',
      label: l('Rating'),
      decimalPlaces: 1,
      rules: [
        {
          id: 'domestic',
          assert: cmp('le', answer('rating_kw'), num('70')),
          message: l('Too big'),
        },
      ],
    },
    {
      id: 'share',
      type: 'decimal',
      label: l('Share of the total'),
      decimalPlaces: 2,
      calculation: math('divide', answer('rating_kw'), answer('total_kw')),
    },
    {
      id: 'result',
      type: 'radio',
      label: l('Result'),
      required: true,
      options: opts('pass', 'fail'),
    },
    {
      id: 'defect',
      type: 'long_text',
      label: l('Defect'),
      required: true,
      minLength: 5,
      visibleWhen: cmp('eq', answer('result'), text('fail')),
    },
  ],
  ...extra,
});
const withAppliances = {
  schemaVersion: 1,
  title: l('Landlord gas safety record'),
  pages: [
    {
      id: 'property_page',
      sections: [
        {
          id: 'property_section',
          fields: [
            {
              id: 'property',
              type: 'radio',
              label: l('Property'),
              options: opts('owned', 'rental'),
            },
            {
              id: 'total_kw',
              type: 'decimal',
              label: l('Total rating'),
              decimalPlaces: 1,
              calculation: total('sum', 'appliances', 'rating_kw'),
            },
          ],
        },
      ],
    },
    {
      id: 'appliance_page',
      sections: [
        appliances(),
        {
          id: 'summary',
          fields: [
            {
              id: 'appliance_count',
              type: 'number',
              label: l('Appliances'),
              calculation: count('appliances'),
            },
            {
              id: 'largest_kw',
              type: 'decimal',
              label: l('Largest'),
              decimalPlaces: 1,
              calculation: total('max', 'appliances', 'rating_kw'),
            },
            {
              id: 'remedial',
              type: 'long_text',
              label: l('Remedial works'),
              required: true,
              visibleWhen: some('appliances', cmp('eq', answer('result'), text('fail'))),
            },
            {
              id: 'all_passed',
              type: 'checkbox',
              label: l('Certify every appliance passed'),
              required: true,
              visibleWhen: every('appliances', cmp('eq', answer('result'), text('pass'))),
            },
          ],
        },
      ],
    },
  ],
};

export const CASES: ConformanceCase[] = [
  {
    name: 'boiler service with a failure path, reversed',
    context: { today: '2026-09-13' },
    definition: {
      schemaVersion: 1,
      title: l('Boiler service', 'صيانة الغلاية'),
      pages: [
        {
          id: 'inspection',
          sections: [
            {
              id: 'outcome',
              fields: [
                {
                  id: 'result',
                  type: 'radio',
                  label: l('Result'),
                  required: true,
                  options: opts('pass', 'fail'),
                },
                {
                  id: 'reason',
                  type: 'long_text',
                  label: l('Reason'),
                  required: true,
                  minLength: 10,
                  visibleWhen: cmp('eq', answer('result'), text('fail')),
                },
                { id: 'isolated', type: 'checkbox', label: l('Supply isolated'), required: true },
              ],
            },
            {
              id: 'follow_up',
              visibleWhen: answered('reason'),
              fields: [
                { id: 'escalate', type: 'yes_no', label: l('Escalate'), allowNotApplicable: true },
                {
                  id: 'faults',
                  type: 'multi_select',
                  label: l('Faults'),
                  options: opts('leak', 'noise', 'heat'),
                  minSelected: 1,
                },
              ],
            },
          ],
        },
        {
          id: 'sign_off',
          visibleWhen: cmp('ne', answer('result'), text('fail')),
          sections: [
            {
              id: 'signature_section',
              fields: [{ id: 'signed', type: 'signature', label: l('Signature'), required: true }],
            },
          ],
        },
      ],
    },
    steps: [
      { type: 'touch', field: 'result' },
      set('result', 'fail'),
      set('reason', 'Seal perished'),
      set('faults', ['noise', 'leak']),
      set('escalate', 'not_applicable'),
      { type: 'submit' },
      set('isolated', true),
      set('result', 'pass'),
      set('signed', {
        mediaId: '6f1c2a4e-9b1d-4c3e-8a2f-1d2e3f4a5b6c',
        contentType: 'image/png',
        byteSize: 20480,
      }),
      { type: 'submit' },
      { type: 'reopen' },
    ],
    submission: {
      result: 'pass',
      isolated: true,
      reason: 'left over from before',
      signed: {
        mediaId: '6f1c2a4e-9b1d-4c3e-8a2f-1d2e3f4a5b6c',
        contentType: 'image/png',
        byteSize: 20480,
      },
    },
  },
  {
    name: 'decimal arithmetic and rounding at both signs',
    definition: form([
      { id: 'hours', type: 'decimal', label: l('Hours'), decimalPlaces: 2 },
      {
        id: 'rate',
        type: 'decimal',
        label: l('Rate'),
        decimalPlaces: 2,
        min: '-500.00',
        max: '500.00',
      },
      {
        id: 'labour',
        type: 'decimal',
        label: l('Labour'),
        decimalPlaces: 2,
        calculation: math('multiply', answer('hours'), answer('rate')),
      },
      {
        id: 'per_third',
        type: 'decimal',
        label: l('Per third'),
        decimalPlaces: 3,
        calculation: math('divide', answer('labour'), num('3')),
      },
      {
        id: 'whole',
        type: 'number',
        label: l('Whole'),
        calculation: math('subtract', answer('labour'), num('0.5')),
      },
      {
        id: 'sum',
        type: 'decimal',
        label: l('Sum'),
        decimalPlaces: 6,
        calculation: math('add', num('0.1'), num('0.2')),
      },
      {
        id: 'zero_division',
        type: 'decimal',
        label: l('Zero'),
        decimalPlaces: 2,
        calculation: math('divide', answer('hours'), num('0')),
      },
    ]),
    steps: [
      set('hours', '2.25'),
      set('rate', '45.10'),
      set('rate', '-45.10'),
      set('hours', '0.01'),
      set('rate', '500.01'),
      set('hours', '1.005'),
    ],
  },
  {
    name: 'calendars, clocks and offsets',
    context: { today: '2024-02-29' },
    definition: form([
      {
        id: 'installed',
        type: 'date',
        label: l('Installed'),
        earliest: '2000-02-29',
        latest: '2100-02-28',
      },
      {
        id: 'overdue',
        type: 'checkbox',
        label: l('Overdue'),
        visibleWhen: cmp('lt', answer('installed'), { kind: 'today' }),
      },
      { id: 'arrived', type: 'time', label: l('Arrived'), earliest: '06:00' },
      {
        id: 'left',
        type: 'time',
        label: l('Left'),
        rules: [
          {
            id: 'after_arrival',
            assert: cmp('gt', answer('left'), answer('arrived')),
            message: l('Leave after arriving'),
          },
        ],
      },
      { id: 'logged', type: 'datetime', label: l('Logged'), latest: '2024-03-01T00:00:00Z' },
      {
        id: 'late_log',
        type: 'text',
        label: l('Why late'),
        visibleWhen: cmp('gt', answer('logged'), {
          kind: 'datetime',
          value: '2024-02-29T20:00+02:00',
        }),
      },
    ]),
    steps: [
      set('installed', '2024-02-29'),
      set('installed', '2024-02-28'),
      set('installed', '2023-02-29'),
      set('arrived', '09:00'),
      set('left', '08:59'),
      set('logged', '2024-02-29T23:59:59-00:30'),
      set('logged', '2024-03-01T02:00+03:00'),
      set('logged', '2024-02-29T18:00:01Z'),
    ],
  },
  {
    name: 'length in characters, not code units',
    definition: form([
      { id: 'name_ar', type: 'text', label: l('Name', 'الاسم'), maxLength: 4 },
      { id: 'emoji', type: 'text', label: l('Mood'), maxLength: 2, minLength: 2 },
      { id: 'barcode', type: 'barcode', label: l('Barcode'), maxLength: 5 },
    ]),
    steps: [
      set('name_ar', 'شريف'),
      set('name_ar', 'شريفة'),
      set('emoji', '👍🏽'),
      set('emoji', '😀'),
      set('barcode', 'ABCDE'),
      set('barcode', 'ABCDEF'),
    ],
  },
  {
    name: 'patterns, with and without case',
    definition: form([
      {
        id: 'serial',
        type: 'text',
        label: l('Serial'),
        pattern: { source: '[A-Z]{2}-\\d{4}(?:-[A-Z])?' },
      },
      {
        id: 'postcode',
        type: 'text',
        label: l('Postcode'),
        pattern: { source: '[a-z]{1,2}\\d[a-z\\d]? ?\\d[a-z]{2}', caseInsensitive: true },
      },
      {
        id: 'phone',
        type: 'text',
        label: l('Phone'),
        pattern: { source: '\\+?\\d{1,3}[ -]?\\(?\\d{2,4}\\)?[ -]?\\d{3,4}[ -]?\\d{3,4}' },
      },
    ]),
    steps: [
      set('serial', 'AB-1234'),
      set('serial', 'AB-1234-X'),
      set('serial', 'ab-1234'),
      set('postcode', 'SW1A 1AA'),
      set('postcode', 'sw1a1aa'),
      set('postcode', 'SW1A-1AA'),
      set('phone', '+20 (02) 2345 6789'),
      set('phone', 'call me'),
    ],
  },
  {
    name: 'three-valued logic in every combination',
    definition: form([
      { id: 'a', type: 'yes_no', label: l('A') },
      { id: 'b', type: 'yes_no', label: l('B') },
      {
        id: 'when_all',
        type: 'checkbox',
        label: l('all'),
        visibleWhen: {
          kind: 'all',
          operands: [cmp('eq', answer('a'), text('yes')), cmp('eq', answer('b'), text('yes'))],
        },
      },
      {
        id: 'when_any',
        type: 'checkbox',
        label: l('any'),
        visibleWhen: {
          kind: 'any',
          operands: [cmp('eq', answer('a'), text('yes')), cmp('eq', answer('b'), text('yes'))],
        },
      },
      {
        id: 'when_not_a',
        type: 'checkbox',
        label: l('not a'),
        visibleWhen: { kind: 'not', operand: cmp('eq', answer('a'), text('yes')) },
      },
      {
        id: 'when_a_blank',
        type: 'checkbox',
        label: l('a blank'),
        visibleWhen: { kind: 'not', operand: answered('a') },
      },
    ]),
    steps: [
      set('a', 'yes'),
      set('b', 'no'),
      set('b', 'yes'),
      set('a', 'no'),
      { type: 'clear', field: 'a' },
      { type: 'clear', field: 'b' },
    ],
  },
  {
    name: 'every other field type, answered well and badly',
    definition: form([
      { id: 'count', type: 'number', label: l('Count'), min: -3, max: 3, unit: 'pcs' },
      { id: 'rating', type: 'rating', label: l('Rating'), scale: 4 },
      {
        id: 'kind',
        type: 'dropdown',
        label: l('Kind'),
        options: opts('gas', 'oil'),
        default: 'gas',
      },
      {
        id: 'photos',
        type: 'photo',
        label: l('Photos'),
        minFiles: 1,
        maxFiles: 2,
        maxFileBytes: 5000000,
      },
      {
        id: 'certificate',
        type: 'file',
        label: l('Certificate'),
        acceptedTypes: ['application/pdf', 'image/*'],
      },
      { id: 'location', type: 'gps', label: l('Location'), maxAccuracyMeters: '20.5' },
      { id: 'reference', type: 'text', label: l('Reference'), readOnly: true, default: 'JOB-0001' },
    ]),
    steps: [
      set('count', -4),
      set('count', 3),
      set('rating', 5),
      set('kind', 'coal'),
      set('reference', 'JOB-0002'),
      set('photos', [
        {
          mediaId: '6f1c2a4e-9b1d-4c3e-8a2f-1d2e3f4a5b6c',
          contentType: 'image/heic',
          byteSize: 6000000,
        },
      ]),
      set('certificate', [
        { mediaId: '6f1c2a4e-9b1d-4c3e-8a2f-1d2e3f4a5b6c', contentType: 'text/csv', byteSize: 12 },
      ]),
      set('location', { latitude: '30.044420', longitude: '31.235712', accuracyMeters: '20.6' }),
      set('location', { latitude: '-90', longitude: '180', accuracyMeters: '20.5' }),
      set('count', 'three'),
    ],
    submission: {
      count: 1,
      rating: 2,
      kind: 'oil',
      photos: [],
      extra: true,
      reference: 'JOB-0001',
    },
  },
  {
    name: 'publish-time errors, worded exactly',
    definition: {
      schemaVersion: 1,
      title: l('Broken'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'gated',
              visibleWhen: answered('inside'),
              fields: [
                { id: 'inside', type: 'text', label: l('Inside') },
                { id: 'ping', type: 'text', label: l('Ping'), visibleWhen: answered('pong') },
                {
                  id: 'pong',
                  type: 'decimal',
                  label: l('Pong'),
                  decimalPlaces: 1,
                  calculation: math('add', answer('total'), num('1')),
                },
                {
                  id: 'total',
                  type: 'decimal',
                  label: l('Total'),
                  decimalPlaces: 1,
                  visibleWhen: answered('ping'),
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'publish-time errors before the graph',
    definition: form([
      { id: 'result', type: 'radio', label: l('Result'), options: opts('pass', 'fail') },
      {
        id: 'why',
        type: 'text',
        label: l('Why'),
        visibleWhen: cmp('eq', answer('result'), text('fial')),
      },
      { id: 'count', type: 'number', label: l('Count'), min: 5, max: 2 },
      { id: 'code', type: 'text', label: l('Code'), pattern: { source: '(\\d+)+x' } },
      {
        id: 'when',
        type: 'date',
        label: l('When'),
        visibleWhen: cmp('lt', answer('when_typo'), { kind: 'today' }),
      },
      {
        id: 'mixed',
        type: 'text',
        label: l('Mixed'),
        visibleWhen: cmp('eq', answer('count'), text('5')),
      },
    ]),
  },
  {
    name: 'a structurally invalid definition',
    definition: {
      schemaVersion: 1,
      title: {},
      pages: [{ id: 'Page One', sections: [] }],
      extra: true,
    },
  },
  {
    name: 'migrating a draft to a changed version',
    definition: form([
      { id: 'contact', type: 'text', label: l('Contact') },
      { id: 'delay', type: 'text', label: l('Delay') },
      {
        id: 'result',
        type: 'radio',
        label: l('Result'),
        options: opts('pass', 'fail', 'deferred'),
      },
      { id: 'faults', type: 'multi_select', label: l('Faults'), options: opts('leak', 'noise') },
      { id: 'readings', type: 'number', label: l('Readings') },
    ]),
    steps: [
      set('contact', 'Dana'),
      set('delay', 'Access'),
      set('result', 'deferred'),
      set('faults', ['noise', 'leak']),
      set('readings', 40),
    ],
    migrateTo: form([
      { id: 'readings', type: 'number', label: l('Readings'), max: 10 },
      { id: 'faults', type: 'multi_select', label: l('Faults'), options: opts('leak') },
      { id: 'result', type: 'radio', label: l('Result'), options: opts('pass', 'fail') },
      { id: 'contact', type: 'text', label: l('Contact') },
    ]),
  },
  {
    name: 'appliances one by one, with rules inside each entry and across them',
    definition: withAppliances,
    steps: [
      { type: 'submit' },
      set('property', 'rental'),
      addEntry('appliances', 'e1'),
      set('make', 'Worcester'),
      setIn('e0', 'make', 'Worcester'),
      setIn('e1', 'make', 'Worcester'),
      setIn('e1', 'kind', 'gas'),
      setIn('e1', 'rating_kw', '24.0'),
      setIn('e1', 'result', 'pass'),
      { type: 'touch', field: 'flue_ok', entry: 'e1' },
      addEntry('appliances', 'e2', 0),
      setIn('e2', 'make', 'Baxi'),
      setIn('e2', 'kind', 'electric'),
      setIn('e2', 'rating_kw', '80.5'),
      setIn('e2', 'result', 'fail'),
      setIn('e2', 'defect', 'Leak'),
      setIn('e2', 'share', '1.00'),
      addEntry('appliances', 'e2'),
      addEntry('appliances', 'bad id'),
      addEntry('appliances', 'e3'),
      addEntry('appliances', 'e4'),
      { type: 'move_entry', section: 'appliances', entry: 'e3', index: 0 },
      { type: 'remove_entry', section: 'appliances', entry: 'e3' },
      { type: 'remove_entry', section: 'appliances', entry: 'e3' },
      { type: 'add_entry', section: 'summary', entry: 'e5' },
      setIn('e1', 'flue_ok', 'yes'),
      { type: 'submit' },
      setIn('e2', 'defect', 'Casing cracked'),
      setIn('e2', 'rating_kw', '30.0'),
      set('remedial', 'Replace the casing'),
      { type: 'submit' },
      { type: 'reopen' },
      setIn('e2', 'result', 'pass'),
      { type: 'remove_entry', section: 'appliances', entry: 'e2' },
      { type: 'submit' },
      set('all_passed', true),
      { type: 'submit' },
    ],
    submission: {
      property: 'owned',
      make: 'Stray',
      appliance_count: 2,
      appliances: [
        {
          id: 'e1',
          values: {
            make: 'Worcester',
            kind: 'electric',
            flue_ok: 'yes',
            landlord_ref: 'L-1',
            rating_kw: 24,
            share: '1.00',
            result: 'pass',
            colour: 'red',
          },
        },
        { id: 'e1', values: { make: 'Twin' } },
      ],
      all_passed: true,
    },
  },
  {
    name: 'entries that are not entries, as a server receives them',
    definition: withAppliances,
    submission: { property: 'owned', appliances: { id: 'e1' } },
  },
  {
    name: 'publish-time errors for repeatable sections, worded exactly',
    definition: {
      schemaVersion: 1,
      title: l('Entries'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'plain',
              fields: [
                {
                  id: 'outside',
                  type: 'text',
                  label: l('Outside'),
                  visibleWhen: cmp('eq', answer('reading'), num('1')),
                },
                {
                  id: 'counted',
                  type: 'number',
                  label: l('Counted'),
                  calculation: count('plain'),
                },
                {
                  id: 'summed',
                  type: 'number',
                  label: l('Summed'),
                  calculation: total('sum', 'readings', 'outside'),
                },
                {
                  id: 'texts',
                  type: 'number',
                  label: l('Texts'),
                  calculation: total('max', 'readings', 'label_text'),
                },
                {
                  id: 'tested',
                  type: 'text',
                  label: l('Tested'),
                  visibleWhen: some('readings', answer('reading')),
                },
              ],
            },
            {
              id: 'readings',
              repeat: {
                minEntries: 4,
                maxEntries: 2,
                entryLabel: l('Reading'),
                titleField: 'photo',
              },
              fields: [
                { id: 'reading', type: 'number', label: l('Reading') },
                { id: 'label_text', type: 'text', label: l('Label') },
                { id: 'photo', type: 'photo', label: l('Photo') },
                {
                  id: 'elsewhere',
                  type: 'text',
                  label: l('Elsewhere'),
                  visibleWhen: answered('other_value'),
                },
              ],
            },
            {
              id: 'empty_repeat',
              repeat: { maxEntries: 5, entryLabel: l('Nothing'), titleField: 'outside' },
              fields: [],
            },
            {
              id: 'others',
              repeat: { maxEntries: 5, entryLabel: l('Other') },
              fields: [{ id: 'other_value', type: 'text', label: l('Other value') }],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'a circular rule through entries',
    definition: form(
      [
        {
          id: 'running',
          type: 'number',
          label: l('Running total'),
          calculation: total('sum', 'section_1', 'running'),
        },
      ],
      { repeat: { maxEntries: 5, entryLabel: l('Row') } },
    ),
  },
  {
    name: 'migrating entries to a changed version',
    definition: {
      schemaVersion: 1,
      title: l('Before'),
      pages: [
        {
          id: 'page_1',
          sections: [
            appliances(),
            {
              id: 'radiators',
              repeat: { maxEntries: 10, entryLabel: l('Radiator') },
              fields: [{ id: 'room', type: 'text', label: l('Room') }],
            },
            {
              id: 'property_section',
              fields: [
                {
                  id: 'property',
                  type: 'radio',
                  label: l('Property'),
                  options: opts('owned', 'rental'),
                },
                {
                  id: 'total_kw',
                  type: 'decimal',
                  label: l('Total'),
                  decimalPlaces: 1,
                  calculation: total('sum', 'appliances', 'rating_kw'),
                },
              ],
            },
          ],
        },
      ],
    },
    steps: [
      set('property', 'rental'),
      addEntry('appliances', 'a1'),
      setIn('a1', 'make', 'Worcester'),
      setIn('a1', 'kind', 'gas'),
      setIn('a1', 'landlord_ref', 'L-9'),
      setIn('a1', 'result', 'fail'),
      addEntry('appliances', 'a2'),
      setIn('a2', 'make', 'Baxi'),
      setIn('a2', 'kind', 'electric'),
      addEntry('radiators', 'r1'),
      setIn('r1', 'room', 'Kitchen'),
    ],
    migrateTo: {
      schemaVersion: 1,
      title: l('After'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'appliances',
              repeat: { maxEntries: 1, entryLabel: l('Appliance') },
              fields: [
                { id: 'make', type: 'text', label: l('Make'), maxLength: 5 },
                { id: 'kind', type: 'radio', label: l('Kind'), options: opts('gas') },
                { id: 'result', type: 'radio', label: l('Result'), options: opts('pass', 'fail') },
              ],
            },
            {
              id: 'radiators',
              fields: [{ id: 'room', type: 'text', label: l('Room') }],
            },
            {
              id: 'property_section',
              fields: [
                {
                  id: 'property',
                  type: 'radio',
                  label: l('Property'),
                  options: opts('owned', 'rental'),
                },
                { id: 'landlord_ref', type: 'text', label: l('Landlord reference') },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'required only when, and choices that depend on another answer',
    definition: form([
      {
        id: 'area',
        type: 'radio',
        label: l('Area'),
        required: true,
        options: opts('kitchen', 'bathroom', 'outside'),
      },
      {
        id: 'room',
        type: 'dropdown',
        label: l('Where exactly'),
        options: opts('sink', 'hob', 'bath', 'garden'),
        dependsOn: {
          field: 'area',
          options: { sink: ['kitchen'], hob: ['kitchen'], bath: ['bathroom'] },
        },
      },
      {
        id: 'hazards',
        type: 'multi_select',
        label: l('Hazards'),
        options: opts('wet', 'gas', 'height'),
      },
      {
        id: 'ppe',
        type: 'multi_select',
        label: l('Protection'),
        options: opts('gloves', 'mask', 'harness'),
        dependsOn: {
          field: 'hazards',
          options: { gloves: ['wet', 'gas'], mask: ['gas'], harness: ['height'] },
        },
      },
      {
        id: 'note',
        type: 'text',
        label: l('Access note'),
        requiredWhen: cmp('eq', answer('area'), text('outside')),
      },
      {
        id: 'isolated',
        type: 'checkbox',
        label: l('Gas isolated'),
        requiredWhen: includes('hazards', 'gas'),
      },
    ]),
    steps: [
      { type: 'submit' },
      set('area', 'kitchen'),
      set('room', 'sink'),
      set('area', 'bathroom'),
      { type: 'touch', field: 'room' },
      set('room', 'bath'),
      set('hazards', ['gas', 'height']),
      set('ppe', ['mask', 'harness']),
      set('hazards', ['height']),
      set('ppe', ['harness']),
      set('area', 'outside'),
      set('room', 'garden'),
      set('note', 'Ladder needed'),
      { type: 'submit' },
    ],
    submission: {
      area: 'kitchen',
      room: 'bath',
      hazards: ['gas'],
      ppe: ['mask'],
      isolated: false,
      note: 'left over',
    },
  },
  {
    name: 'publish-time errors for dependent choices and required-when, worded exactly',
    definition: {
      schemaVersion: 1,
      title: l('Dependent'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'plain',
              fields: [
                { id: 'area', type: 'radio', label: l('Area'), options: opts('kitchen', 'loft') },
                { id: 'count', type: 'number', label: l('Count') },
                {
                  id: 'room_1',
                  type: 'dropdown',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'missing', options: {} },
                },
                {
                  id: 'room_2',
                  type: 'dropdown',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'plain', options: {} },
                },
                {
                  id: 'room_3',
                  type: 'dropdown',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'count', options: {} },
                },
                {
                  id: 'room_4',
                  type: 'radio',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'area', options: { a: ['kitchen', 'cellar'] } },
                },
                {
                  id: 'room_5',
                  type: 'multi_select',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'area', options: { c: ['kitchen'] } },
                },
                {
                  id: 'room_6',
                  type: 'dropdown',
                  label: l('Room'),
                  options: opts('a', 'b'),
                  dependsOn: { field: 'make', options: {} },
                },
                {
                  id: 'flag',
                  type: 'text',
                  label: l('Flag'),
                  requiredWhen: answer('count'),
                },
                {
                  id: 'doubled',
                  type: 'number',
                  label: l('Doubled'),
                  calculation: math('multiply', answer('count'), num('2')),
                  requiredWhen: answered('count'),
                },
              ],
            },
            {
              id: 'appliances',
              repeat: { maxEntries: 3, entryLabel: l('Appliance') },
              fields: [
                { id: 'make', type: 'radio', label: l('Make'), options: opts('baxi', 'vaillant') },
                {
                  id: 'model',
                  type: 'dropdown',
                  label: l('Model'),
                  options: opts('b_1', 'v_1'),
                  dependsOn: { field: 'make', options: { b_1: ['baxi'], v_1: ['vaillant'] } },
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    name: 'circular dependent choices',
    definition: form([
      {
        id: 'a',
        type: 'radio',
        label: l('A'),
        options: opts('x'),
        dependsOn: { field: 'b', options: {} },
      },
      {
        id: 'b',
        type: 'radio',
        label: l('B'),
        options: opts('x'),
        dependsOn: { field: 'a', options: {} },
      },
      {
        id: 'c',
        type: 'dropdown',
        label: l('C'),
        options: opts('x'),
        dependsOn: { field: 'c', options: {} },
      },
    ]),
  },
];
