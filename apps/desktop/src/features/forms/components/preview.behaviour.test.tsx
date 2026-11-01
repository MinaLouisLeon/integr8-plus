// @vitest-environment jsdom
import {
  type CompiledForm,
  createFormState,
  type FormEvent,
  transition,
  viewForm,
} from '@integr8/form-engine';
import {
  BEHAVIOUR_TODAY,
  type BehaviourStep,
  behaviourCases,
  entryIds,
  expectedScreen,
  joinScreens,
  readQuestions,
  readScreen,
  type Screen,
  type ScreenQuestion,
  stateOf,
  type Translate,
} from '@integr8/form-input/behaviour';
import { sectionName } from '@integr8/form-renderer-dom';
import { createI18n, I18nextProvider, type I18nInstance } from '@integr8/i18n';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormRenderer } from './form-renderer';
import { PhonePreview } from './phone-preview';

/**
 * The behaviour check, for the builder's preview (P07, owner's decision 5).
 *
 * The phone in the preview is pressed through like a phone — Next, Review,
 * each entry opened from its row — and the desktop view beside it read whole.
 * Both must show what the engine says (`expectedScreen`): the same questions,
 * words, required marks and errors that the phone app's own screens and the
 * web filler are held to in their packages, for the six library forms and the
 * every-type form, in English and in Arabic. See docs/form-engine/builder.md.
 */

afterEach(() => {
  cleanup();
});

const LOCALES = ['en', 'ar'] as const;
const context = { today: BEHAVIOUR_TODAY };

function Phone({
  form,
  step,
  locale,
}: {
  form: CompiledForm;
  step: BehaviourStep;
  locale: string;
}) {
  const [newEntryId] = useState(entryIds);
  const [state, setState] = useState(() => createFormState(form, step.answers, { newEntryId }));
  const onEvent = (event: FormEvent) =>
    setState((current) => transition(form, current, event, context).state);
  return (
    <PhonePreview
      form={form}
      state={state}
      view={viewForm(form, state, context)}
      onEvent={onEvent}
      locale={locale}
      context={context}
      brand={{ colour: '#0f766e', theme: 'light' }}
      newEntryId={newEntryId}
    />
  );
}

/** "Radiators: …": the shared entry list names the section; the engine's words are the rest. */
const unwrapper =
  (form: CompiledForm, i18n: I18nInstance, locale: string) => (text: string, id: string) => {
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
  };

describe.each(LOCALES)('the builder’s preview shows what the engine says (%s)', (locale) => {
  const i18n = createI18n({ locale });
  const translate = i18n.t.bind(i18n) as unknown as Translate;
  const button = (
    container: HTMLElement,
    key: 'fill.actions.next' | 'fill.actions.back' | 'fill.actions.review',
  ) => within(container).queryByRole('button', { name: i18n.t(key) });

  for (const { key, form, steps } of behaviourCases()) {
    describe(key, () => {
      it.each(steps.map((step) => [step.name, step] as const))('phone: %s', (_name, step) => {
        const expected = expectedScreen(
          form,
          viewForm(form, stateOf(form, step), context),
          locale,
          translate,
        );
        const { container } = render(
          <I18nextProvider i18n={i18n}>
            <Phone form={form} step={step} locale={locale} />
          </I18nextProvider>,
        );
        const press = (element: Element | null) => {
          act(() => {
            fireEvent.click(element!);
          });
        };

        if (step.submitted) {
          while (button(container, 'fill.actions.next') !== null) {
            press(button(container, 'fill.actions.next'));
          }
          press(button(container, 'fill.actions.review'));
        }

        const pages: Screen[] = [];
        if (container.querySelector('[data-part="review"]') !== null) {
          pages.push(readScreen(container));
        } else {
          while ((button(container, 'fill.actions.back') as HTMLButtonElement).disabled === false) {
            press(button(container, 'fill.actions.back'));
          }
          for (;;) {
            const page = readScreen(container);
            const questions: ScreenQuestion[] = [];
            for (const section of page.sections) {
              questions.push(
                ...page.questions.filter((question) => question.section === section.id),
              );
              const rows = () =>
                Array.from(
                  container.querySelectorAll(
                    `[data-section="${section.id}"] [data-part="entry-title"]`,
                  ),
                );
              const count = section.entries === undefined ? 0 : rows().length;
              for (let index = 0; index < count; index += 1) {
                press(rows()[index]!.closest('button'));
                const open = container.querySelector('[data-entry]')!;
                questions.push(...readQuestions(open, section.id));
                press(open.querySelector('button'));
              }
            }
            pages.push({ ...page, questions });
            const next = button(container, 'fill.actions.next');
            if (next === null) {
              break;
            }
            press(next);
          }
        }
        const shown = joinScreens(pages);
        expect(shown.reviewing || shown.questions.length > 0).toBe(true);
        expect(shown).toEqual(expected);
      });

      it.each(steps.map((step) => [step.name, step] as const))('desktop: %s', (_name, step) => {
        const state = stateOf(form, step);
        const view = viewForm(form, state, context);
        const { container } = render(
          <I18nextProvider i18n={i18n}>
            <FormRenderer
              form={form}
              state={state}
              view={view}
              onEvent={() => undefined}
              viewport="desktop"
              locale={locale}
            />
          </I18nextProvider>,
        );
        // The desktop view has no review screen: it shows every page whatever happens.
        expect(readScreen(container, { unwrapProblem: unwrapper(form, i18n, locale) })).toEqual(
          expectedScreen(form, view, locale, translate, { reviewScreen: false }),
        );
      });
    });
  }
});
