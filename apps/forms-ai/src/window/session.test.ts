import { describe, expect, it } from 'vitest';
import { keepAnswers, PreviewSession } from './session.js';
import { tripForm } from './testing/trip-form.js';

type Definition = typeof tripForm;
const changed = (change: (form: Definition) => void): Definition => {
  const copy = structuredClone(tripForm);
  change(copy);
  return copy;
};
const fieldsOf = (form: Definition) =>
  form.pages[0]!.sections[0]!.fields as Record<string, unknown>[];

const answers = {
  purpose: 'Site visit',
  by_car: 'yes',
  km: '120',
  stops: [{ id: 'e1', values: { place: 'Giza' } }],
};

describe('answers kept across a change of form', () => {
  it('keeps every answer when the form is the same', () => {
    expect(keepAnswers(answers, tripForm, tripForm)).toEqual(answers);
  });

  it('drops an answer whose question was removed', () => {
    const after = changed((form) => {
      form.pages[0]!.sections[0]!.fields = fieldsOf(form).filter(
        (field) => field.id !== 'purpose',
      ) as (typeof form.pages)[0]['sections'][0]['fields'];
    });
    expect(keepAnswers(answers, tripForm, after)).not.toHaveProperty('purpose');
    expect(keepAnswers(answers, tripForm, after)).toHaveProperty('km', '120');
  });

  it('drops an answer whose question changed type', () => {
    const after = changed((form) => {
      const purpose = fieldsOf(form).find((field) => field.id === 'purpose')!;
      purpose.type = 'number';
    });
    const kept = keepAnswers(answers, tripForm, after);
    expect(kept).not.toHaveProperty('purpose');
    expect(kept).toHaveProperty('by_car', 'yes');
  });

  it('keeps entries of a repeating section, and only their questions that remain', () => {
    const after = changed((form) => {
      form.pages[0]!.sections[1]!.fields.push({
        id: 'arrived',
        type: 'text',
        label: { en: 'Arrived', ar: 'الوصول' },
      });
    });
    expect(keepAnswers(answers, tripForm, after).stops).toEqual([
      { id: 'e1', values: { place: 'Giza' } },
    ]);
    const without = changed((form) => {
      form.pages[0]!.sections[1]!.fields[0]!.id = 'location';
    });
    expect(keepAnswers(answers, tripForm, without).stops).toEqual([{ id: 'e1', values: {} }]);
  });

  it('keeps the answers as they are while the new form does not compile', () => {
    expect(keepAnswers(answers, tripForm, { pages: 'broken' })).toEqual(answers);
  });
});

describe('the preview session', () => {
  it('needs a form first, then takes changes in part and tells listeners', () => {
    const session = new PreviewSession();
    expect(() => session.update({ templates: [] })).toThrow(/no form/u);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    expect(session.update({ definition: tripForm }).ok).toBe(true);
    session.setAnswers(answers);
    session.update({ templates: [{ name: 'Report', design: {} }] });
    expect(session.content?.definition).toEqual(tripForm);
    expect(session.answers).toEqual(answers);
    expect(session.version).toBe(2);
    expect(events).toEqual([
      { type: 'state', version: 1 },
      { type: 'state', version: 2 },
    ]);
  });

  it('keeps typed answers through an update of the form', () => {
    const session = new PreviewSession();
    session.update({ definition: tripForm });
    session.setAnswers(answers);
    session.update({
      definition: changed((form) => {
        form.title.en = 'Business trip';
      }),
    });
    expect(session.answers).toEqual(answers);
  });

  it('returns each note once', () => {
    const session = new PreviewSession();
    session.addNote({ tab: 'form', about: 'km', text: 'Make it required' });
    expect(session.takeUnreadNotes()).toMatchObject([
      { tab: 'form', about: 'km', text: 'Make it required', read: true },
    ]);
    expect(session.takeUnreadNotes()).toEqual([]);
  });

  it('forgets the print of a template that changed and keeps the others', () => {
    const session = new PreviewSession();
    const templates = [
      { name: 'A', design: { n: 1 } },
      { name: 'B', design: { n: 2 } },
    ];
    session.update({ definition: tripForm, templates });
    const ready = {
      status: 'ready' as const,
      version: 1,
      options: { useAnswers: false, language: undefined, companyColour: undefined },
      by: 'window' as const,
      at: new Date().toISOString(),
      pdfPath: '/tmp/a.pdf',
    };
    session.setPrint(0, ready);
    session.setPrint(1, ready);
    session.update({ templates: [templates[0]!, { name: 'B', design: { n: 3 } }] });
    expect(session.print(0)).toBeDefined();
    expect(session.print(1)).toBeUndefined();
  });

  it('limits the pictures the window holds', () => {
    const session = new PreviewSession();
    const big = new Uint8Array(40 * 1024 * 1024);
    expect(session.addMedia({ contentType: 'image/png', bytes: big })).toBeDefined();
    expect(session.addMedia({ contentType: 'image/png', bytes: big })).toBeUndefined();
  });
});
