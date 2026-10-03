import type { Field } from '@integr8/form-engine';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AnswerView } from './answer-view.js';
import { FormFiller } from './form-filler.js';
import { accessibilityViolations, formOf, renderWithI18n } from './testing/render.js';

/**
 * The fill flow for a long form: progress, section navigation, required-field
 * blocking with a jump-to-error list, a review screen, and what is finally sent.
 */

const result: Field = {
  id: 'result',
  type: 'radio',
  required: true,
  label: { en: 'Result' },
  options: [
    { value: 'pass', label: { en: 'Pass' } },
    { value: 'fail', label: { en: 'Fail' } },
  ],
};

const reason: Field = {
  id: 'reason',
  type: 'long_text',
  required: true,
  label: { en: 'Reason for failure' },
  visibleWhen: {
    kind: 'compare',
    operator: 'eq',
    left: { kind: 'answer', field: 'result' },
    right: { kind: 'text', value: 'fail' },
  },
};

const site: Field = { id: 'site', type: 'text', required: true, label: { en: 'Site name' } };
const visits: Field = { id: 'visits', type: 'number', label: { en: 'Visits' } };
const doubled: Field = {
  id: 'doubled',
  type: 'number',
  label: { en: 'Visits doubled' },
  calculation: {
    kind: 'arithmetic',
    operator: 'multiply',
    left: { kind: 'answer', field: 'visits' },
    right: { kind: 'number', value: '2' },
  },
};

const longForm = () =>
  formOf(
    [
      [site, visits, doubled],
      [result, reason],
    ],
    'Boiler service',
  );

describe('filling a long form', () => {
  it('shows one page at a time, with every page listed and progress announced', async () => {
    const user = userEvent.setup();
    const { container } = renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );

    const navigation = screen.getByRole('navigation', { name: 'Sections of this form' });
    expect(
      within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Page 1', 'Page 2']);
    expect(within(navigation).getByRole('button', { name: 'Page 1' })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(
      screen.getByRole('progressbar', { name: '0 of 2 required questions answered' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Result/u })).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Site name/u }), 'Depot');
    expect(
      screen.getByRole('progressbar', { name: '1 of 2 required questions answered' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('group', { name: /Result/u })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('works out calculated answers as they change, and announces them', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Visits' }), '3');
    const output = screen.getByRole('status', { name: 'Visits doubled' });
    expect(output).toHaveTextContent('6');
  });

  it('shows a question only when its condition holds', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={formOf([[result, reason]])}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    expect(screen.queryByRole('textbox', { name: /Reason for failure/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    expect(screen.getByRole('textbox', { name: /Reason for failure/u })).toBeInTheDocument();
  });
});

describe('required questions block review', () => {
  it('lists every problem, and each entry takes the person to the question', async () => {
    const user = userEvent.setup();
    const { container } = renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Review answers' }));

    const summary = await screen.findByRole('alert');
    expect(within(summary).getByRole('heading')).toHaveTextContent('There are 2 problems to fix');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(screen.queryByRole('heading', { name: 'Check your answers' })).not.toBeInTheDocument();

    // The first problem is on page 1, so that is where the person is taken.
    await user.click(within(summary).getByRole('button', { name: 'Go to “Site name”' }));
    const siteInput = screen.getByRole('textbox', { name: /Site name/u });
    await waitFor(() => expect(siteInput).toHaveFocus());
    expect(siteInput).toHaveAttribute('aria-invalid', 'true');

    await user.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Go to “Result”' }),
    );
    await waitFor(() => expect(screen.getByRole('group', { name: /Result/u })).toHaveFocus());
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('marks the pages that have problems in the navigation', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    const navigation = screen.getByRole('navigation');
    expect(within(navigation).getByRole('button', { name: /Page 1/u })).toHaveTextContent(
      '1 problem',
    );
    expect(within(navigation).getByRole('button', { name: /Page 2/u })).toHaveTextContent(
      '1 problem',
    );
  });
});

describe('review and submit', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByRole('textbox', { name: /Site name/u }), 'Depot');
    await user.type(screen.getByRole('textbox', { name: 'Visits' }), '2');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'Fail' }));
    await user.type(screen.getByRole('textbox', { name: /Reason for failure/u }), 'Flue blocked');
    await user.click(screen.getByRole('button', { name: 'Review answers' }));
  };

  it('shows exactly what will be sent, and sends the engine’s submission', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { container } = renderWithI18n(
      <FormFiller form={longForm()} locale="en" onSubmit={onSubmit} />,
    );
    await fill(user);

    expect(screen.getByRole('heading', { name: 'Check your answers' })).toBeInTheDocument();
    const answers = screen.getAllByRole('definition').map((node) => node.textContent);
    expect(answers).toEqual(['Depot', '2', '4', 'Fail', 'Flue blocked']);
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Submit' }));
    // Calculated values are the server's to work out; they are not sent.
    expect(onSubmit).toHaveBeenCalledWith(
      { site: 'Depot', visits: 2, result: 'fail', reason: 'Flue blocked' },
      {},
    );
  });

  it('lets the person change a page from the review, and keeps what they typed', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() => Promise.resolve({ ok: true as const })}
      />,
    );
    await fill(user);
    await user.click(screen.getAllByRole('button', { name: 'Change' })[0]!);
    expect(screen.getByRole('textbox', { name: /Site name/u })).toHaveValue('Depot');
  });

  it('shows the server’s refusal, each reason a link to its question', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <FormFiller
        form={longForm()}
        locale="en"
        onSubmit={() =>
          Promise.resolve({
            ok: false as const,
            problems: [{ field: 'site', message: 'This site is closed.' }],
          })
        }
      />,
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const alert = await screen.findByRole('alert');
    await user.click(
      within(alert).getByRole('button', { name: 'Site name: This site is closed.' }),
    );
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Site name/u })).toHaveFocus());
  });

  it('asks why when submitting a correction', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const }));
    renderWithI18n(
      <FormFiller
        form={formOf([[visits]])}
        initialAnswers={{ visits: 1 }}
        locale="en"
        correction
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Review answers' }));
    await user.click(screen.getByRole('button', { name: 'Submit correction' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Say why this is being corrected.');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(
      screen.getByRole('textbox', { name: /Why is this being corrected/u }),
      'Miscounted',
    );
    await user.click(screen.getByRole('button', { name: 'Submit correction' }));
    expect(onSubmit).toHaveBeenCalledWith({ visits: 1 }, { reason: 'Miscounted' });
  });

  it('can be filled start to finish with the keyboard alone', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const }));
    renderWithI18n(<FormFiller form={formOf([[site, result]])} locale="en" onSubmit={onSubmit} />);

    const siteInput = screen.getByRole('textbox', { name: /Site name/u });
    while (document.activeElement !== siteInput) {
      await user.tab();
    }
    await user.keyboard('Depot');
    await user.tab();
    await user.keyboard(' ');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Check your answers' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Submit' }).focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ site: 'Depot', result: 'pass' }, {});
  });
});

describe('answers read back', () => {
  it('reads each answer as a person would, and marks what changed since an earlier version', async () => {
    const form = formOf([[site, result, reason, visits, doubled]]);
    const { container } = renderWithI18n(
      <AnswerView
        form={form}
        locale="en"
        answers={{ site: 'Depot', result: 'fail', reason: 'Leak', visits: 3 }}
        previous={{ site: 'Depot', result: 'pass', visits: 3 }}
      />,
    );
    const rows = screen.getAllByRole('term').map((term) => term.textContent);
    expect(rows).toEqual([
      'Site name',
      'ResultChanged',
      'Reason for failureChanged',
      'Visits',
      'Visits doubled',
    ]);
    expect(screen.getAllByRole('definition').map((node) => node.textContent)).toEqual([
      'Depot',
      'Fail',
      'Leak',
      '3',
      '6',
    ]);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('leaves out questions hidden for these answers, and says so when one was not answered', () => {
    renderWithI18n(
      <AnswerView
        form={formOf([[site, result, reason]])}
        locale="en"
        answers={{ result: 'pass' }}
      />,
    );
    expect(screen.queryByText('Reason for failure')).not.toBeInTheDocument();
    expect(screen.getAllByRole('definition')[0]).toHaveTextContent('Not answered');
  });
});
