import { ApiRequestError } from '@integr8/api-client';
import type { CompiledForm, Field } from '@integr8/form-engine';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerView } from './answer-view.js';
import { FormFiller } from './form-filler.js';
import { problemsOf } from './screens/api.js';
import { accessibilityViolations, compile, renderWithI18n } from './testing/render.js';

/**
 * Repeatable sections (P13b), filled in and read back: a list of entries a
 * person adds to, removes from and reorders, each asking the section's
 * questions again, with every change announced and focus kept where it belongs.
 */

const make: Field = { id: 'make', type: 'text', required: true, label: { en: 'Make' } };
const pressure: Field = { id: 'pressure', type: 'number', label: { en: 'Pressure' } };
const site: Field = { id: 'site', type: 'text', label: { en: 'Site name' } };

function appliances(repeat: { minEntries?: number; maxEntries?: number } = {}): CompiledForm {
  return compile({
    schemaVersion: 1,
    title: { en: 'Gas safety' },
    pages: [
      {
        id: 'page_1',
        title: { en: 'Visit' },
        sections: [
          { id: 'visit', fields: [site] },
          {
            id: 'appliances',
            title: { en: 'Appliances' },
            repeat: {
              maxEntries: repeat.maxEntries ?? 3,
              entryLabel: { en: 'Appliance' },
              titleField: 'make',
              ...(repeat.minEntries === undefined ? {} : { minEntries: repeat.minEntries }),
            },
            fields: [make, pressure],
          },
        ],
      },
    ],
  });
}

/** Entry ids a test can name: entry-1, entry-2, … */
function ids() {
  let next = 0;
  return () => {
    next += 1;
    return `entry-${String(next)}`;
  };
}

const entry = (name: string | RegExp) => screen.getByRole('group', { name });
const headings = () =>
  screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent);

describe('filling a repeatable section', () => {
  it('opens with the entries the section needs, each with its own questions', async () => {
    const { container } = renderWithI18n(
      <FormFiller
        form={appliances({ minEntries: 1 })}
        locale="en"
        newEntryId={ids()}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    expect(headings()).toEqual(['Appliance 1']);
    expect(
      within(entry('Appliance 1')).getByRole('textbox', { name: /Make/u }),
    ).toBeInTheDocument();
    // The only entry cannot be removed: the section needs one.
    expect(screen.getByRole('button', { name: 'Remove Appliance 1' })).toBeDisabled();
    expect(screen.getByText('At least 1 needed.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('adds an entry, moves focus to its first question and says so', async () => {
    const user = userEvent.setup();
    const onAnswersChange = vi.fn();
    renderWithI18n(
      <FormFiller
        form={appliances()}
        locale="en"
        newEntryId={ids()}
        onAnswersChange={onAnswersChange}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    expect(screen.getByText('None added yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ Add Appliance' }));
    const first = within(entry('Appliance 1')).getByRole('textbox', { name: /Make/u });
    await waitFor(() => expect(first).toHaveFocus());
    expect(screen.getByText('Appliance 1 added.')).toBeInTheDocument();
    // Adding an entry is a change to autosave.
    expect(onAnswersChange).toHaveBeenLastCalledWith({
      appliances: [{ id: 'entry-1', values: {} }],
    });

    await user.click(screen.getByRole('button', { name: '+ Add Appliance' }));
    await user.click(screen.getByRole('button', { name: '+ Add Appliance' }));
    expect(headings()).toEqual(['Appliance 1', 'Appliance 2', 'Appliance 3']);
    // Three is as many as the section allows.
    expect(screen.queryByRole('button', { name: '+ Add Appliance' })).not.toBeInTheDocument();
    expect(screen.getByText('No more than 3 can be added.')).toBeInTheDocument();
  });

  it('answers a question inside one entry, names the entry by it, and sends entries', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const }));
    renderWithI18n(
      <FormFiller
        form={appliances({ minEntries: 2 })}
        locale="en"
        newEntryId={ids()}
        onSubmit={onSubmit}
      />,
    );
    await user.type(
      within(entry('Appliance 1')).getByRole('textbox', { name: /Make/u }),
      'Vaillant',
    );
    await user.type(within(entry('Appliance 2')).getByRole('textbox', { name: /Make/u }), 'Ideal');
    await user.type(within(entry(/Appliance 2/u)).getByRole('textbox', { name: 'Pressure' }), '2');
    expect(headings()).toEqual(['Appliance 1 · Vaillant', 'Appliance 2 · Ideal']);

    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    expect(screen.getByRole('heading', { name: 'Check your answers' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSubmit).toHaveBeenCalledWith(
      {
        appliances: [
          { id: 'entry-1', values: { make: 'Vaillant' } },
          { id: 'entry-2', values: { make: 'Ideal', pressure: 2 } },
        ],
      },
      {},
    );
  });

  it('asks before removing an entry with answers, and moves focus to the entry that takes its place', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={appliances()}
        locale="en"
        newEntryId={ids()}
        initialAnswers={{
          appliances: [
            { id: 'a', values: { make: 'Vaillant' } },
            { id: 'b', values: {} },
            { id: 'c', values: { make: 'Baxi' } },
          ],
        }}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );

    // An entry with nothing in it goes straight away.
    await user.click(screen.getByRole('button', { name: 'Remove Appliance 2' }));
    expect(headings()).toEqual(['Appliance 1 · Vaillant', 'Appliance 2 · Baxi']);
    expect(screen.getByText('Appliance 2 removed.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Appliance 2 · Baxi' })).toHaveFocus(),
    );

    // One with answers asks first, and keeping it changes nothing.
    await user.click(screen.getByRole('button', { name: 'Remove Appliance 1 · Vaillant' }));
    const confirm = screen.getByRole('button', { name: 'Yes, remove it' });
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(confirm).toHaveAccessibleDescription(
      'Remove Appliance 1 · Vaillant? The answers in it will be lost.',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Yes, remove it' })).not.toBeInTheDocument();
    expect(headings()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove Appliance 1 · Vaillant' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove it' }));
    expect(headings()).toEqual(['Appliance 1 · Baxi']);
    expect(screen.getByText('Appliance 1 · Vaillant removed.')).toBeInTheDocument();
  });

  it('reorders entries with buttons, keeping focus on the moved entry and announcing where it went', async () => {
    const user = userEvent.setup();
    const onAnswersChange = vi.fn();
    renderWithI18n(
      <FormFiller
        form={appliances()}
        locale="en"
        onAnswersChange={onAnswersChange}
        initialAnswers={{
          appliances: [
            { id: 'a', values: { make: 'Vaillant' } },
            { id: 'b', values: { make: 'Baxi' } },
          ],
        }}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Move Appliance 1 · Vaillant up' })).toBeDisabled();

    screen.getByRole('button', { name: 'Move Appliance 2 · Baxi up' }).focus();
    await user.keyboard('{Enter}');
    expect(headings()).toEqual(['Appliance 1 · Baxi', 'Appliance 2 · Vaillant']);
    expect(screen.getByText('Appliance 1 · Baxi moved to position 1 of 2.')).toBeInTheDocument();
    // At the top "up" is disabled, so focus stays with the entry on "down".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Appliance 1 · Baxi down' })).toHaveFocus(),
    );
    expect(onAnswersChange).toHaveBeenLastCalledWith({
      appliances: [
        { id: 'b', values: { make: 'Baxi' } },
        { id: 'a', values: { make: 'Vaillant' } },
      ],
    });
  });

  it('shows each entry’s problems in it, names the entry in the problem list, and goes to it', async () => {
    const user = userEvent.setup();
    const { container } = renderWithI18n(
      <FormFiller
        form={appliances({ minEntries: 3 })}
        locale="en"
        initialAnswers={{
          appliances: [
            { id: 'a', values: { make: 'Vaillant' } },
            { id: 'b', values: {} },
          ],
        }}
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Review answers' }));

    const summary = await screen.findByRole('alert');
    expect(
      within(summary)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Go to “Appliances”', 'Go to “Make” in Appliance 2']);
    // The section's own problem sits beside its heading, with its name.
    expect(screen.getByText('Appliances: Add at least 3.')).toBeInTheDocument();
    expect(within(entry('Appliance 2')).getByText('1 problem')).toBeInTheDocument();
    expect(
      within(entry('Appliance 1 · Vaillant')).queryByText('1 problem'),
    ).not.toBeInTheDocument();

    await user.click(within(summary).getByRole('button', { name: 'Go to “Make” in Appliance 2' }));
    const input = within(entry('Appliance 2')).getByRole('textbox', { name: /Make/u });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Go to “Appliances”' }),
    );
    await waitFor(() =>
      expect(screen.getByText('Appliances: Add at least 3.').closest('ul')).toHaveFocus(),
    );
  });
});

describe('the server refusing an entry', () => {
  it('reads which entry a reason is about, and takes the person to that entry’s question', async () => {
    const refusal = new ApiRequestError(422, 'invalid_answers', 'Refused', 'req-1', [
      { field: 'body.answers.site', code: 'required', message: 'Say where.' },
      { field: 'body.answers.appliances[b].make', code: 'invalid', message: 'Unknown make.' },
      { field: 'body.today', code: 'today_out_of_range', message: 'Wrong day.' },
    ]);
    const problems = problemsOf(refusal);
    expect(problems).toEqual([
      { field: 'site', message: 'Say where.' },
      { field: 'make', entry: 'b', message: 'Unknown make.' },
      { field: undefined, message: 'Wrong day.' },
    ]);

    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={appliances()}
        locale="en"
        initialAnswers={{
          appliances: [
            { id: 'a', values: { make: 'Vaillant' } },
            { id: 'b', values: { make: 'Zzz' } },
          ],
        }}
        onSubmit={() => Promise.resolve({ ok: false as const, problems: [problems[1]!] })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Make: Unknown make.' }));
    const input = within(entry('Appliance 2 · Zzz')).getByRole('textbox', { name: /Make/u });
    await waitFor(() => expect(input).toHaveFocus());
  });
});

describe('entries read back', () => {
  it('lists each section’s entries under their titles, and marks what changed', async () => {
    const form = appliances();
    const { container } = renderWithI18n(
      <AnswerView
        form={form}
        locale="en"
        answers={{
          site: 'Depot',
          appliances: [
            { id: 'a', values: { make: 'Vaillant', pressure: 2 } },
            { id: 'c', values: { make: 'Baxi' } },
          ],
        }}
        previous={{
          site: 'Depot',
          appliances: [
            { id: 'a', values: { make: 'Vaillant', pressure: 1 } },
            { id: 'b', values: { make: 'Ideal' } },
          ],
        }}
      />,
    );
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Appliances');
    expect(headings()).toEqual(['Appliance 1 · Vaillant', 'Appliance 2 · Baxi']);
    const lists = screen.getAllByRole('listitem');
    expect(
      within(lists[0]!)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Make', 'PressureChanged']);
    expect(
      within(lists[1]!)
        .getAllByRole('definition')
        .map((node) => node.textContent),
    ).toEqual(['Baxi', 'Not answered']);
    expect(screen.getByText('1 entry removed')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says when a section has no entries', () => {
    renderWithI18n(<AnswerView form={appliances()} locale="en" answers={{ site: 'Depot' }} />);
    expect(screen.getByText('None added')).toBeInTheDocument();
  });
});
