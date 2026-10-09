import {
  type CompiledForm,
  compileDefinition,
  createFormState,
  transition,
  viewForm,
} from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import {
  canAddEntry,
  checkChosenFiles,
  dependentChoices,
  entryTitle,
  editGeoPoint,
  errorMessage,
  firstPerField,
  fitWithin,
  formatBytes,
  geoPointFrom,
  isRequiredNow,
  normaliseDigits,
  offeredOptions,
  pageIndexOfField,
  prefillAnswers,
  problemsPerPage,
  progressFraction,
  readDecimal,
  readInteger,
  say,
  strokesToPath,
  toggleOffered,
  toggleOption,
  toPadPoint,
  visiblePages,
  withOffset,
  worthKeeping,
} from './index.js';

function compiled(definition: unknown): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.form;
}

const label = (en: string) => ({ en });

function boilerForm(extra: Record<string, unknown>[] = []) {
  return compiled({
    schemaVersion: 1,
    title: label('Boiler service'),
    pages: [
      {
        id: 'appliance',
        sections: [
          {
            id: 'details',
            fields: [
              { id: 'make', type: 'text', label: label('Make'), required: true },
              {
                id: 'fuel',
                type: 'radio',
                label: label('Fuel'),
                options: [
                  { value: 'gas', label: label('Gas') },
                  { value: 'oil', label: label('Oil') },
                ],
              },
              {
                id: 'checks',
                type: 'multi_select',
                label: label('Checks'),
                options: [
                  { value: 'flue', label: label('Flue') },
                  { value: 'seals', label: label('Seals') },
                  { value: 'pressure', label: label('Pressure') },
                ],
              },
              ...extra,
            ],
          },
        ],
      },
      {
        id: 'sign_off',
        sections: [
          {
            id: 'evidence',
            fields: [
              { id: 'photos', type: 'photo', label: label('Photos') },
              { id: 'signature', type: 'signature', label: label('Signature'), required: true },
              { id: 'where', type: 'gps', label: label('Where') },
              { id: 'notes', type: 'long_text', label: label('Notes'), readOnly: true },
            ],
          },
        ],
      },
    ],
  });
}

describe('text', () => {
  it('shows the language asked for, then English, then anything', () => {
    expect(say({ en: 'Result', ar: 'النتيجة' }, 'ar')).toBe('النتيجة');
    expect(say({ en: 'Result' }, 'ar')).toBe('Result');
    expect(say({ fr: 'Résultat' }, 'ar')).toBe('Résultat');
    expect(say(undefined, 'en')).toBe('');
  });

  it('turns Arabic and Persian digits into the ones the engine stores', () => {
    expect(normaliseDigits('٣٫٥')).toBe('3.5');
    expect(normaliseDigits('۱۲۰')).toBe('120');
    expect(normaliseDigits('−4')).toBe('-4');
  });

  it('writes date-times with the offset, east and west of UTC', () => {
    expect(withOffset('2026-09-13T14:05', 180)).toBe('2026-09-13T14:05:00+03:00');
    expect(withOffset('2026-09-13T14:05', -330)).toBe('2026-09-13T14:05:00-05:30');
    expect(withOffset('2026-09-13T14:05', 0)).toBe('2026-09-13T14:05:00+00:00');
  });

  it('writes sizes a person can read', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(5 * 1024 * 1024, 'en')).toBe('5 MB');
  });
});

describe('answers from controls', () => {
  it('keeps a number being typed until it is one', () => {
    expect(readInteger('-')).toEqual({ text: '-', answer: undefined, unfinished: true });
    expect(readInteger(' ٤٢ ')).toEqual({ text: '42', answer: 42, unfinished: false });
    expect(readInteger('')).toEqual({ text: '', answer: '', unfinished: false });
    expect(readDecimal('١٢٫٥٠')).toBe('12.50');
  });

  it('orders a multi-select as the form lists its options, whatever order they were ticked', () => {
    const options = [{ value: 'flue' }, { value: 'seals' }, { value: 'pressure' }];
    expect(toggleOption(options, ['pressure'], 'flue', true)).toEqual(['flue', 'pressure']);
    expect(toggleOption(options, ['flue', 'pressure'], 'flue', false)).toEqual(['pressure']);
  });

  it('stores a location as decimal text, six places and accuracy to one', () => {
    expect(geoPointFrom({ latitude: 53.80071234567, longitude: -1.5491, accuracy: 7.349 })).toEqual(
      { latitude: '53.800712', longitude: '-1.549100', accuracyMeters: '7.3' },
    );
    expect(geoPointFrom({ latitude: 1, longitude: 2, accuracy: null })).toEqual({
      latitude: '1.000000',
      longitude: '2.000000',
    });
  });

  it('edits a typed location box by box, and clears it when both coordinates are gone', () => {
    const point = editGeoPoint(undefined, 'latitude', '٥٣٫٨');
    expect(point).toEqual({ latitude: '53.8', longitude: '' });
    expect(editGeoPoint({ latitude: '53.8', longitude: '' }, 'latitude', '')).toBeUndefined();
    expect(
      editGeoPoint({ latitude: '1', longitude: '2', accuracyMeters: '5' }, 'accuracyMeters', ''),
    ).toEqual({ latitude: '1', longitude: '2' });
  });
});

describe('what the view says about a question', () => {
  const area = {
    id: 'area',
    type: 'radio',
    label: label('Area'),
    options: [
      { value: 'kitchen', label: label('Kitchen') },
      { value: 'bathroom', label: label('Bathroom') },
    ],
  };
  const room = {
    id: 'room',
    type: 'dropdown',
    label: label('Room'),
    options: [
      { value: 'sink', label: label('Sink') },
      { value: 'bath', label: label('Bath') },
      { value: 'other', label: label('Other') },
    ],
    dependsOn: { field: 'area', options: { sink: ['kitchen'], bath: ['bathroom'] } },
  };
  const note = {
    id: 'note',
    type: 'text',
    label: label('Note'),
    requiredWhen: {
      kind: 'compare',
      operator: 'eq',
      left: { kind: 'answer', field: 'area' },
      right: { kind: 'text', value: 'bathroom' },
    },
  };
  const form = compiled({
    schemaVersion: 1,
    title: label('Rooms'),
    pages: [{ id: 'p', sections: [{ id: 's', fields: [area, room, note] }] }],
  });

  it('says whether a question is required right now, following the answers', () => {
    const noteField = form.elements.get('note')!.field!;
    let state = createFormState(form);
    expect(isRequiredNow(viewForm(form, state), noteField)).toBe(false);
    state = transition(form, state, { type: 'answer', field: 'area', value: 'bathroom' }).state;
    expect(isRequiredNow(viewForm(form, state), noteField)).toBe(true);
  });

  it('names the question a dependent choice follows, and what it offers', () => {
    const roomField = form.elements.get('room')!.field!;
    let state = createFormState(form);
    expect(dependentChoices(form, viewForm(form, state), roomField, 'en')).toEqual({
      options: [],
      parentAnswered: false,
      parentLabel: 'Area',
    });
    state = transition(form, state, { type: 'answer', field: 'area', value: 'kitchen' }).state;
    expect(dependentChoices(form, viewForm(form, state), roomField, 'en')?.options).toEqual([
      'sink',
      'other',
    ]);
    expect(
      dependentChoices(form, viewForm(form, state), form.elements.get('area')!.field!, 'en'),
    ).toBeUndefined();
  });

  it('draws every option when nothing is said, and only those on offer otherwise', () => {
    expect(offeredOptions(room.options, undefined)).toBe(room.options);
    expect(offeredOptions(room.options, ['other']).map((option) => option.value)).toEqual([
      'other',
    ]);
  });

  it('drops a choice no longer on offer the moment the question is touched', () => {
    const options = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];
    expect(toggleOffered(options, ['a', 'c'], ['b'], 'c', true)).toEqual(['c']);
    expect(toggleOffered(options, undefined, ['b', 'c'], 'a', true)).toEqual(['a', 'b', 'c']);
    expect(toggleOffered(options, ['a', 'b'], ['a', 'b'], 'a', false)).toEqual(['b']);
  });
});

describe('files', () => {
  it('fits a photo within the longest edge, and leaves a small one alone', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536, scaled: true });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
  });

  it('takes what fits and says why the rest does not', () => {
    const chosen = [
      { name: 'a.jpg', contentType: 'image/jpeg', byteSize: 500 },
      { name: 'b.pdf', contentType: 'application/pdf', byteSize: 500 },
      { name: 'c.jpg', contentType: 'image/jpeg', byteSize: 5000 },
      { name: 'd.jpg', contentType: 'image/jpeg', byteSize: 10 },
    ];
    const { accepted, problems } = checkChosenFiles(
      { type: 'photo', maxFiles: 4, maxFileBytes: 1000 },
      1,
      chosen,
    );
    expect(accepted.map((file) => file.name)).toEqual(['a.jpg']);
    expect(problems).toEqual([
      { code: 'too_many', maximum: 4 },
      { code: 'wrong_type', name: 'b.pdf' },
      { code: 'too_large', name: 'c.jpg', maximum: 1000 },
    ]);
    expect(
      checkChosenFiles({ type: 'file', acceptedTypes: ['application/pdf'] }, 0, chosen).accepted,
    ).toEqual([chosen[1]]);
  });
});

describe('navigation', () => {
  it('knows which page each question is on and counts one problem per question', () => {
    const form = boilerForm();
    let state = createFormState(form);
    state = transition(form, state, { type: 'submit' }).state;
    const view = viewForm(form, state);
    const pages = visiblePages(form, view);
    expect(pages.map((page) => page.id)).toEqual(['appliance', 'sign_off']);
    expect(pageIndexOfField(pages, 'signature')).toBe(1);
    expect(pageIndexOfField(pages, 'nope')).toBe(-1);
    expect(firstPerField(view.shownErrors).map((error) => error.field)).toEqual([
      'make',
      'signature',
    ]);
    expect(problemsPerPage(pages, view)).toEqual([1, 1]);
    expect(progressFraction(view)).toBe(0);
  });
});

describe('prefill', () => {
  it('carries what describes the appliance, and nothing that records the visit', () => {
    const form = boilerForm();
    const previous = {
      make: 'Worcester',
      fuel: 'gas',
      checks: ['flue'],
      photos: [
        { mediaId: '0192f2b4-0000-7000-8000-000000000001', contentType: 'image/jpeg', byteSize: 1 },
      ],
      signature: {
        mediaId: '0192f2b4-0000-7000-8000-000000000002',
        contentType: 'image/png',
        byteSize: 1,
      },
      where: { latitude: '1', longitude: '2' },
      notes: 'fixed',
    };
    expect(prefillAnswers(form, form, previous)).toEqual({
      answers: { make: 'Worcester', fuel: 'gas', checks: ['flue'] },
      filled: ['make', 'fuel', 'checks'],
    });
  });

  it('moves answers from an older version: a removed option goes, a new question stays empty', () => {
    const older = boilerForm();
    const newer = compiled({
      ...older.definition,
      pages: [
        {
          id: 'appliance',
          sections: [
            {
              id: 'details',
              fields: [
                { id: 'make', type: 'text', label: label('Make') },
                { id: 'serial', type: 'barcode', label: label('Serial') },
                {
                  id: 'checks',
                  type: 'multi_select',
                  label: label('Checks'),
                  options: [{ value: 'flue', label: label('Flue') }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      prefillAnswers(older, newer, { make: 'Vaillant', fuel: 'oil', checks: ['flue', 'seals'] }),
    ).toEqual({ answers: { make: 'Vaillant', checks: ['flue'] }, filled: ['make', 'checks'] });
  });
});

describe('error messages', () => {
  it('uses the admin’s own words for a rule, and the catalogue for everything else', () => {
    const field = {
      id: 'pressure',
      type: 'number',
      label: label('Pressure'),
      rules: [
        {
          id: 'safe',
          assert: { kind: 'boolean', value: true },
          message: label('Too high to sign off'),
        },
      ],
    } as unknown as Parameters<typeof errorMessage>[0];
    const translate = (key: string, params: Record<string, string>) =>
      `${key} ${JSON.stringify(params)}`;
    expect(
      errorMessage(
        field,
        { field: 'pressure', code: 'rule_failed', params: { rule: 'safe' } },
        'en',
        translate,
      ),
    ).toBe('Too high to sign off');
    expect(
      errorMessage(
        field,
        { field: 'pressure', code: 'above_maximum', params: { maximum: '10' } },
        'en',
        translate,
      ),
    ).toBe('form.errors.above_maximum {"maximum":"10"}');
  });
});

describe('signatures', () => {
  it('maps a touch to the pad, keeping it on the pad', () => {
    expect(toPadPoint(120, 40, { width: 240, height: 80 })).toEqual([240, 80]);
    expect(toPadPoint(-5, 900, { width: 240, height: 80 })).toEqual([0, 160]);
  });

  it('drops points too close to be seen, and draws a tap as a dot', () => {
    expect(worthKeeping(undefined, [1, 1])).toBe(true);
    expect(worthKeeping([1, 1], [1.5, 1.5])).toBe(false);
    expect(worthKeeping([1, 1], [4, 1])).toBe(true);
    expect(
      strokesToPath([
        [
          [10, 20],
          [30.26, 40],
        ],
        [[5, 5]],
        [],
      ]),
    ).toBe('M10 20 L30.3 40 M5 5 l0.1 0');
  });
});

describe('entries', () => {
  const rooms = () =>
    compiled({
      schemaVersion: 1,
      title: label('Radiators'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'radiators',
              repeat: {
                maxEntries: 2,
                entryLabel: { en: 'Radiator', ar: 'مشع' },
                titleField: 'room',
              },
              fields: [
                { id: 'room', type: 'text', label: label('Room'), required: true },
                { id: 'photo', type: 'photo', label: label('Photo') },
                { id: 'bleed', type: 'checkbox', label: label('Bled'), required: true },
              ],
            },
          ],
        },
      ],
    });

  it('names each entry by its place and its title answer, and counts a problem per question per entry', () => {
    const form = rooms();
    let state = createFormState(form);
    for (const event of [
      { type: 'add_entry', section: 'radiators', entry: 'r1' },
      { type: 'add_entry', section: 'radiators', entry: 'r2' },
      { type: 'answer', field: 'room', value: ' Kitchen ', entry: 'r2' },
      { type: 'submit' },
    ] as const) {
      state = transition(form, state, event).state;
    }
    const view = viewForm(form, state);
    const section = form.definition.pages[0]!.sections[0]!;
    const [first, second] = view.entries.get('radiators')!;
    expect(entryTitle(section, first!, 0, 'en')).toEqual({ label: 'Radiator 1', name: undefined });
    expect(entryTitle(section, second!, 1, 'ar')).toEqual({
      label: `مشع ${new Intl.NumberFormat('ar').format(2)}`,
      name: 'Kitchen',
    });
    expect(canAddEntry(section, view)).toBe(false);
    expect(
      firstPerField(view.shownErrors).map((error) => `${error.entry ?? ''}/${error.field}`),
    ).toEqual(['r1/room', 'r1/bleed', 'r2/bleed']);
    expect(pageIndexOfField(visiblePages(form, view), 'radiators')).toBe(0);
  });

  it('names an entry by the words a choice picked, and a date as the language writes it', () => {
    const form = compiled({
      schemaVersion: 1,
      title: label('Appliances'),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'appliances',
              repeat: { maxEntries: 2, entryLabel: label('Appliance'), titleField: 'kind' },
              fields: [
                {
                  id: 'kind',
                  type: 'radio',
                  label: label('Kind'),
                  options: [{ value: 'combi_boiler', label: { en: 'Combi boiler' } }],
                },
                { id: 'fitted', type: 'date', label: label('Fitted') },
              ],
            },
          ],
        },
      ],
    });
    let state = createFormState(form);
    for (const event of [
      { type: 'add_entry', section: 'appliances', entry: 'a1' },
      { type: 'answer', field: 'kind', value: 'combi_boiler', entry: 'a1' },
      { type: 'answer', field: 'fitted', value: '2019-03-02', entry: 'a1' },
    ] as const) {
      state = transition(form, state, event).state;
    }
    const section = form.definition.pages[0]!.sections[0]!;
    const [entry] = viewForm(form, state).entries.get('appliances')!;
    expect(entryTitle(section, entry!, 0, 'en').name).toBe('Combi boiler');
    expect(
      entryTitle(
        { ...section, repeat: { ...section.repeat!, titleField: 'fitted' } },
        entry!,
        0,
        'en',
      ).name,
    ).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date('2019-03-02T12:00:00Z'),
      ),
    );
  });

  it('prefills entries with what describes each one, keeping their ids, and drops an entry with nothing left', () => {
    const form = rooms();
    const photo = {
      mediaId: '0192f2b4-0000-7000-8000-000000000003',
      contentType: 'image/jpeg',
      byteSize: 1,
    };
    expect(
      prefillAnswers(form, form, {
        radiators: [
          { id: 'r1', values: { room: 'Hall', photo: [photo], bleed: true } },
          { id: 'r2', values: { photo: [photo] } },
        ],
      }),
    ).toEqual({
      answers: { radiators: [{ id: 'r1', values: { room: 'Hall', bleed: true } }] },
      filled: ['room', 'bleed'],
    });
  });
});
