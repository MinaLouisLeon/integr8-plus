import { fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerView } from './answer-view.js';
import { FormFiller } from './form-filler.js';
import { accessibilityViolations, compile, renderWithI18n } from './testing/render.js';

/**
 * Schema version 2 on web and desktop: descriptions under titles, Information
 * blocks among the questions (shown when their rule holds, never sent), and a
 * calculated date written as a date.
 */

const form = () =>
  compile({
    schemaVersion: 2,
    title: { en: 'Boiler service' },
    pages: [
      {
        id: 'page_1',
        title: { en: 'Safety' },
        description: { en: 'Read this page before touching the boiler.' },
        sections: [
          {
            id: 'checks',
            title: { en: 'Checks' },
            description: { en: 'One line\nand another' },
            fields: [
              {
                id: 'result',
                type: 'radio',
                label: { en: 'Result' },
                options: [
                  { value: 'pass', label: { en: 'Pass' } },
                  { value: 'fail', label: { en: 'Fail' } },
                ],
              },
              {
                id: 'isolate',
                type: 'information',
                heading: { en: 'Isolate first' },
                body: { en: 'Turn the gas off.\n<b>Then</b> test.' },
                style: 'warning',
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'result' },
                  right: { kind: 'text', value: 'fail' },
                },
              },
              { id: 'serviced', type: 'date', label: { en: 'Serviced on' } },
              {
                id: 'due',
                type: 'date',
                label: { en: 'Next service due' },
                calculation: {
                  kind: 'shift_date',
                  operator: 'add',
                  unit: 'months',
                  date: { kind: 'answer', field: 'serviced' },
                  amount: { kind: 'number', value: '12' },
                },
              },
            ],
          },
        ],
      },
    ],
  });

describe('schema version 2 in the DOM filler', () => {
  it('shows descriptions, shows an Information block when its rule holds, and never sends it', async () => {
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { container } = renderWithI18n(
      <FormFiller form={form()} locale="en" today="2026-01-31" onSubmit={onSubmit} />,
    );
    expect(screen.getByText('Read this page before touching the boiler.')).toBeTruthy();
    expect(screen.getByText(/One line/u).textContent).toBe('One line\nand another');
    expect(screen.queryByText('Isolate first')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    await waitFor(() => expect(screen.getByText('Isolate first')).toBeTruthy());
    const note = screen.getByRole('note');
    expect(note.getAttribute('data-style')).toBe('warning');
    expect(note.textContent).toContain('Warning');
    // Plain text: the angle brackets are shown, not read as markup.
    expect(note.textContent).toContain('<b>Then</b> test.');
    expect(note.querySelector('b')).toBeNull();
    expect(await accessibilityViolations(container)).toEqual([]);

    fireEvent.change(screen.getByLabelText('Serviced on'), { target: { value: '2026-01-31' } });
    await waitFor(() => expect(screen.getByText('Jan 31, 2027')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ result: 'fail', serviced: '2026-01-31' }, {});
  });

  it('lists no Information block among the answers', () => {
    renderWithI18n(
      <AnswerView
        form={form()}
        answers={{ result: 'fail', serviced: '2026-01-31', due: '2027-01-31' }}
        locale="en"
      />,
    );
    expect(screen.queryByText('Isolate first')).toBeNull();
    expect(screen.getByText('Next service due')).toBeTruthy();
    // The stored value, as the server worked it out.
    expect(screen.getByText(/2027/u)).toBeTruthy();
  });
});
