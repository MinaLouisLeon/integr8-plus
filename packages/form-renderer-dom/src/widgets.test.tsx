import { type Field, FIELD_TYPES, type FieldType, newField } from '@integr8/form-engine';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { type UserEvent, userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FormFiller } from './form-filler.js';
import { accessibilityViolations, formOf, memoryMedia, renderWithI18n } from './testing/render.js';

/**
 * P08's fourth exit criterion: every field type in the registry has a working,
 * accessible widget.
 *
 * "Every" is enforced, not listed: the table below is checked against the
 * engine's registry, so a field type P06 adds fails here until it has a widget
 * and a test. For each type, the widget is found by its accessible name — the
 * way a screen reader finds it — answered the way a person would, and the answer
 * the engine received is checked. axe-core runs on the rendered question before
 * and after.
 */

type Answering = (user: UserEvent, label: string) => Promise<void>;

const label = (type: FieldType) => `Question about ${type.replaceAll('_', ' ')}`;

const cases: Record<FieldType, { answer: Answering; expected: (value: unknown) => void }> = {
  text: {
    answer: async (user, name) =>
      user.type(screen.getByRole('textbox', { name }), 'Riverside Depot'),
    expected: (value) => expect(value).toBe('Riverside Depot'),
  },
  long_text: {
    answer: async (user, name) =>
      user.type(screen.getByRole('textbox', { name }), 'Two{Enter}lines'),
    expected: (value) => expect(value).toBe('Two\nlines'),
  },
  barcode: {
    answer: async (user, name) => user.type(screen.getByRole('textbox', { name }), 'SN-00421'),
    expected: (value) => expect(value).toBe('SN-00421'),
  },
  number: {
    answer: async (user, name) => user.type(screen.getByRole('textbox', { name }), '-42'),
    expected: (value) => expect(value).toBe(-42),
  },
  decimal: {
    // Typed on an Arabic keyboard.
    answer: async (user, name) => user.type(screen.getByRole('textbox', { name }), '٣٫٥'),
    expected: (value) => expect(value).toBe('3.5'),
  },
  date: {
    answer: (_user, name) => {
      fireEvent.change(screen.getByLabelText(name), { target: { value: '2026-09-13' } });
      return Promise.resolve();
    },
    expected: (value) => expect(value).toBe('2026-09-13'),
  },
  time: {
    answer: (_user, name) => {
      fireEvent.change(screen.getByLabelText(name), { target: { value: '14:05' } });
      return Promise.resolve();
    },
    expected: (value) => expect(value).toBe('14:05'),
  },
  datetime: {
    answer: (_user, name) => {
      fireEvent.change(screen.getByLabelText(name), { target: { value: '2026-09-13T14:05' } });
      return Promise.resolve();
    },
    expected: (value) => expect(value).toMatch(/^2026-09-13T14:05:00[+-]\d{2}:\d{2}$/u),
  },
  dropdown: {
    answer: async (user, name) =>
      user.selectOptions(screen.getByRole('combobox', { name }), 'Option 2'),
    expected: (value) => expect(value).toBe('option_2'),
  },
  radio: {
    answer: async (user, name) => {
      const group = screen.getByRole('group', { name: new RegExp(name, 'u') });
      await user.click(within(group).getByRole('radio', { name: 'Option 1' }));
    },
    expected: (value) => expect(value).toBe('option_1'),
  },
  multi_select: {
    answer: async (user, name) => {
      const group = screen.getByRole('group', { name: new RegExp(name, 'u') });
      await user.click(within(group).getByRole('checkbox', { name: 'Option 2' }));
      await user.click(within(group).getByRole('checkbox', { name: 'Option 1' }));
    },
    // Stored in the form's option order, whatever order they were ticked in.
    expected: (value) => expect(value).toEqual(['option_1', 'option_2']),
  },
  checkbox: {
    answer: async (user, name) =>
      user.click(screen.getByRole('checkbox', { name: new RegExp(name, 'u') })),
    expected: (value) => expect(value).toBe(true),
  },
  yes_no: {
    answer: async (user) => user.click(screen.getByRole('radio', { name: 'No' })),
    expected: (value) => expect(value).toBe('no'),
  },
  rating: {
    // By keyboard: into the group, then along it with the arrow keys.
    answer: async (user) => {
      await user.click(screen.getByRole('radio', { name: '1 out of 5' }));
      await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    },
    expected: (value) => expect(value).toBe(4),
  },
  signature: {
    // The keyboard route every signature pad must offer.
    answer: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Type my name instead' }));
      await user.type(screen.getByRole('textbox', { name: 'Your full name' }), 'A. Engineer');
      await user.click(screen.getByRole('button', { name: 'Use this signature' }));
    },
    expected: (value) =>
      expect(value).toMatchObject({
        contentType: 'image/png',
        mediaId: expect.any(String) as string,
      }),
  },
  photo: {
    answer: async (user) => {
      await user.upload(
        screen.getByLabelText('Add photos'),
        new File(['jpeg'], 'boiler.jpg', { type: 'image/jpeg' }),
      );
    },
    expected: (value) =>
      expect(value).toEqual([expect.objectContaining({ contentType: 'image/jpeg', byteSize: 4 })]),
  },
  file: {
    answer: async (user) => {
      await user.upload(
        screen.getByLabelText('Add files'),
        new File(['%PDF'], 'certificate.pdf', { type: 'application/pdf' }),
      );
    },
    expected: (value) =>
      expect(value).toEqual([expect.objectContaining({ contentType: 'application/pdf' })]),
  },
  gps: {
    answer: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Use my current location' }));
    },
    expected: (value) =>
      expect(value).toEqual({
        latitude: '30.044400',
        longitude: '31.235700',
        accuracyMeters: '5.0',
      }),
  },
};

function fieldFor(type: FieldType): Field {
  return newField(type, `q_${type}`, { en: label(type) });
}

describe('every field type in the registry has a widget', () => {
  it('has a case here for every type, and no case for a type that does not exist', () => {
    expect(Object.keys(cases).sort()).toEqual(FIELD_TYPES.map(({ type }) => type).sort());
  });

  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (success: PositionCallback) =>
        success({
          coords: { latitude: 30.0444, longitude: 31.2357, accuracy: 5 },
          timestamp: 0,
        } as GeolocationPosition),
    },
  });

  it.each(FIELD_TYPES.map(({ type }) => type))(
    '%s: named for assistive technology, answerable, and free of accessibility violations',
    async (type) => {
      const user = userEvent.setup();
      const changes = vi.fn();
      const { container } = renderWithI18n(
        <FormFiller
          form={formOf([[fieldFor(type)]])}
          locale="en"
          media={memoryMedia()}
          onAnswersChange={changes}
          onSubmit={() => Promise.resolve({ ok: true as const })}
        />,
      );

      expect(await accessibilityViolations(container)).toEqual([]);

      await cases[type].answer(user, label(type));

      await waitFor(() => expect(changes).toHaveBeenCalled());
      const answers = changes.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      cases[type].expected(answers[`q_${type}`]);

      expect(await accessibilityViolations(container)).toEqual([]);
    },
  );
});

describe('the widgets say what is wrong, where', () => {
  it('ties an error to its control, so a screen reader reads them together', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={formOf([
          [
            {
              id: 'pressure',
              type: 'decimal',
              decimalPlaces: 2,
              max: '10',
              label: { en: 'Pressure' },
            },
          ],
        ])}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Pressure' });
    await user.type(input, '12');
    await user.tab();

    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain('Must be no more than 10.');
  });

  it('refuses a photo that is too large before it is sent', async () => {
    const user = userEvent.setup();
    const media = memoryMedia();
    renderWithI18n(
      <FormFiller
        form={formOf([[{ id: 'photos', type: 'photo', maxFileBytes: 3, label: { en: 'Photos' } }]])}
        locale="en"
        media={media}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.upload(
      screen.getByLabelText('Add photos'),
      new File(['toolarge'], 'big.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('big.jpg is larger than 3 B.');
    expect(media.upload.mock.calls).toHaveLength(0);
  });

  it('draws a signature with a pointer, mouse, pen or finger alike', async () => {
    const user = userEvent.setup();
    const changes = vi.fn();
    renderWithI18n(
      <FormFiller
        form={formOf([[{ id: 'sign', type: 'signature', label: { en: 'Customer signature' } }]])}
        locale="en"
        media={memoryMedia()}
        onAnswersChange={changes}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    const pad = screen.getByRole('img', { name: /Signature pad/u });
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pad, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    await user.click(screen.getByRole('button', { name: 'Use this signature' }));

    await waitFor(() => expect(changes).toHaveBeenCalled());
    expect((changes.mock.calls.at(-1)?.[0] as Record<string, unknown>).sign).toMatchObject({
      contentType: 'image/png',
    });
    expect(
      await screen.findByRole('img', { name: 'Signature for “Customer signature”' }),
    ).toBeInTheDocument();
  });

  it('asks for a signature before saving an empty pad', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={formOf([[{ id: 'sign', type: 'signature', label: { en: 'Signature' } }]])}
        locale="en"
        media={memoryMedia()}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Use this signature' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Draw or type a signature first.');
  });
});
