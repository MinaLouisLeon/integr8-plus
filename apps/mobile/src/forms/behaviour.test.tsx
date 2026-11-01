// @vitest-environment jsdom
import { viewForm } from '@integr8/form-engine';
import {
  BEHAVIOUR_TODAY,
  behaviourCases,
  entryIds,
  expectedScreen,
  joinScreens,
  readInformation,
  readQuestions,
  readScreen,
  type Screen,
  type ScreenInformation,
  type ScreenQuestion,
  stateOf,
  type Translate,
} from '@integr8/form-input/behaviour';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FillModel } from './fill-model';
import { FormFiller } from './form-filler';

/**
 * The behaviour check, for the phone (P07, owner's decision 5).
 *
 * The phone's own form screen — `FormFiller`, `FieldBlock`, the entry list and
 * entry view, the widgets — rendered with `FillModel`, its real state, and read
 * the way a person would meet it: page by page, opening each entry of a
 * repeating section, Review pressed where the step says so. What it shows must
 * be what the engine says (`expectedScreen`), the same expectation the web
 * filler and the builder's preview are held to.
 *
 * React Native itself is replaced by a stand-in that draws its components as
 * DOM (`src/testing/react-native.tsx`), and the parts that need a device —
 * camera, files, location, signature pad, media storage — by empty ones. So
 * this proves which questions, words, required marks and errors the phone's
 * components produce; it cannot prove how they look on a real screen (pixels,
 * fonts, native pickers). See docs/form-engine/builder.md, "Behaviour check".
 */

vi.mock('react-native', () => import('../testing/react-native'));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ router: { back: () => undefined, push: () => undefined } }));
vi.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, () => Promise.resolve(null)],
}));
vi.mock('@react-native-community/datetimepicker', () => ({
  default: () => null,
  DateTimePickerAndroid: { open: () => undefined },
}));
vi.mock('~/components/brand', () => ({
  useBrand: () => ({ accent: null, shell: null, defaultTheme: 'light' }),
}));
vi.mock('./media', () => ({
  FormMediaProvider: ({ children }: { children: ReactNode }) => children,
  useFormMedia: () => ({
    local: new Map(),
    add: () => Promise.resolve([]),
    remove: () => Promise.resolve(),
  }),
  imageUri: () => undefined,
}));
vi.mock('./widgets/files', () => ({ FilesWidget: () => null, references: () => [] }));
vi.mock('./widgets/gps', () => ({ GpsWidget: () => null }));
vi.mock('./widgets/signature', () => ({ SignatureWidget: () => null }));

afterEach(() => {
  cleanup();
});

const LOCALES = ['en', 'ar'] as const;

describe.each(LOCALES)('the phone shows what the engine says (%s)', (locale) => {
  const i18n = createI18n({ locale });
  const translate = i18n.t.bind(i18n) as unknown as Translate;

  for (const { key, form, steps } of behaviourCases()) {
    it.each(steps.map((step) => [step.name, step] as const))(`${key}: %s`, (_name, step) => {
      const expected = expectedScreen(
        form,
        viewForm(form, stateOf(form, step), { today: BEHAVIOUR_TODAY }),
        locale,
        translate,
      );
      const model = new FillModel({
        form,
        answers: step.answers,
        context: { today: BEHAVIOUR_TODAY },
        save: () => Promise.resolve(),
        newEntryId: entryIds(),
      });
      const { container } = render(
        <I18nextProvider i18n={i18n}>
          <FormFiller
            model={model}
            title="Form"
            subtitle={undefined}
            workOrderId={null}
            locale={locale}
            today={BEHAVIOUR_TODAY}
            correction={false}
            notice={undefined}
            onSubmit={() => Promise.resolve()}
            onClose={() => undefined}
          />
        </I18nextProvider>,
      );
      const pageCount = () => model.snapshot().pages.length;

      if (step.submitted) {
        act(() => model.goToPage(pageCount() - 1));
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
        for (let index = 0; index < pageCount(); index += 1) {
          act(() => model.goToPage(index));
          pages.push(withEntries(readScreen(container), container, model));
        }
      }
      const shown = joinScreens(pages);
      expect(shown.reviewing || shown.questions.length > 0).toBe(true);
      expect(shown).toEqual(expected);
    });
  }
});

/**
 * A repeating section's questions and Information blocks are on the phone only
 * inside an open entry: each entry is opened by tapping its row in the list,
 * read, and closed again.
 */
function withEntries(page: Screen, container: HTMLElement, model: FillModel): Screen {
  const questions: ScreenQuestion[] = [];
  const information: ScreenInformation[] = [];
  for (const section of page.sections) {
    questions.push(...page.questions.filter((question) => question.section === section.id));
    information.push(...page.information.filter((block) => block.section === section.id));
    if (section.entries === undefined) {
      continue;
    }
    const rows = () =>
      Array.from(
        container.querySelectorAll(`[data-section="${section.id}"] [data-part="entry-title"]`),
      );
    // Read afresh each time: opening and closing an entry draws the list again.
    const count = rows().length;
    for (let index = 0; index < count; index += 1) {
      act(() => {
        fireEvent.click(rows()[index]!.closest('button')!);
      });
      const open = container.querySelector('[data-entry]');
      if (open !== null) {
        questions.push(...readQuestions(open, section.id));
        information.push(...readInformation(open, section.id));
      }
      act(() => model.openEntry(undefined));
    }
  }
  return { ...page, questions, information };
}
