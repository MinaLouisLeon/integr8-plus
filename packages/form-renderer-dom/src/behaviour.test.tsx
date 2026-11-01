import { viewForm } from '@integr8/form-engine';
import {
  BEHAVIOUR_TODAY,
  behaviourCases,
  entryIds,
  expectedScreen,
  joinScreens,
  readScreen,
  type Screen,
  stateOf,
  type Translate,
} from '@integr8/form-input/behaviour';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { act, fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sectionName } from './entries.js';
import { FormFiller } from './form-filler.js';
import { memoryMedia } from './testing/render.js';

/**
 * The behaviour check, for the web filler (P07, owner's decision 5).
 *
 * The six library forms and the every-type form, opened with each step's
 * answers, Review pressed where the step says so, then read page by page:
 * every question, its words, its required mark and its errors must be what the
 * engine says (`expectedScreen`). The builder's preview and the phone app run
 * the same cases against the same expectation in their own packages, so the
 * three agree with each other by agreeing with it. See
 * docs/form-engine/builder.md, "Behaviour check".
 */

const LOCALES = ['en', 'ar'] as const;

describe.each(LOCALES)('the web filler shows what the engine says (%s)', (locale) => {
  const i18n = createI18n({ locale });
  const translate = i18n.t.bind(i18n) as unknown as Translate;

  for (const { key, form, steps } of behaviourCases()) {
    it.each(steps.map((step) => [step.name, step] as const))(`${key}: %s`, (_name, step) => {
      const view = viewForm(form, stateOf(form, step), { today: BEHAVIOUR_TODAY });
      const expected: Screen = expectedScreen(form, view, locale, translate);

      const { container, unmount } = render(
        <I18nextProvider i18n={i18n}>
          <FormFiller
            form={form}
            initialAnswers={step.answers}
            locale={locale}
            media={memoryMedia()}
            today={BEHAVIOUR_TODAY}
            newEntryId={entryIds()}
            onSubmit={() => Promise.resolve({ ok: true })}
          />
        </I18nextProvider>,
      );
      const nav = () =>
        within(container.querySelector('nav')!).getAllByRole<HTMLButtonElement>('button');
      if (step.submitted) {
        act(() => {
          fireEvent.click(nav().at(-1)!);
        });
        act(() => {
          fireEvent.click(
            within(container).getByRole('button', { name: i18n.t('fill.actions.review') }),
          );
        });
      }
      const pages: Screen[] = [];
      if (container.querySelector('[data-part="review"]') !== null) {
        pages.push(readScreen(container));
      } else {
        const count = nav().length;
        for (let index = 0; index < count; index += 1) {
          act(() => {
            fireEvent.click(nav()[index]!);
          });
          pages.push(
            readScreen(container, {
              unwrapProblem: (text, id) => {
                // "Radiators: …": the web names the section; the engine's words are the rest.
                const section = form.definition.pages
                  .flatMap((page) => page.sections)
                  .find((candidate) => candidate.id === id)!;
                const [before = '', after = ''] = i18n
                  .t('fill.entries.sectionProblem', {
                    section: sectionName(section, locale),
                    problem: '\u0002',
                  })
                  .split('\u0002');
                return text.startsWith(before) && text.endsWith(after)
                  ? text.slice(before.length, text.length - after.length)
                  : text;
              },
            }),
          );
        }
      }
      const shown = joinScreens(pages);
      // A screen read as nothing would agree with nothing; every step shows something.
      expect(shown.reviewing || shown.questions.length > 0).toBe(true);
      expect(shown).toEqual(expected);
      unmount();
    });
  }
});
