import {
  type Answers,
  type CompiledForm,
  createFormState,
  type EvaluationContext,
  type FieldError,
  type FormEvent,
  type FormState,
  type FormView,
  type Page,
  type Section,
  toSubmission,
  type Transition,
  transition,
  viewForm,
} from '@integr8/form-engine';
import {
  firstPerField,
  pageIndexOfField,
  problemsPerPage,
  progressFraction,
  visiblePages,
} from '@integr8/form-input';

/**
 * Filling one form on the phone, without the UI (P13).
 *
 * Everything the screen shows is derived here from `@integr8/form-engine` — which
 * questions show, what is worked out, what is wrong, how far along the person
 * is — so the React Native components know nothing about any particular form,
 * and this is what the tests drive.
 *
 * **Every change is saved.** Each accepted answer goes to `save` straight away:
 * a write to the phone's database and outbox, a few milliseconds. Saves never
 * overlap and never arrive out of order; while one is running only the latest
 * answers wait, so fast typing costs one write per save rather than one per
 * keystroke queued behind each other. A killed app or a dead battery loses at
 * most the change being written that moment.
 *
 * **Entries, one at a time (P13b).** A repeatable section shows as a list of its
 * entries; adding one, or tapping one, opens it on its own, with only its
 * questions on the screen. Adding, removing and moving an entry are saved like
 * any answer.
 */

export type SaveStatus = 'saved' | 'saving' | 'failed';

export interface FillSnapshot {
  readonly state: FormState;
  readonly view: FormView;
  readonly pages: readonly Page[];
  /** Index into `pages`. */
  readonly pageIndex: number;
  readonly reviewing: boolean;
  readonly saveStatus: SaveStatus;
  /** One problem per question, listed above the form once submitting was tried. */
  readonly problems: readonly FieldError[];
  readonly problemsPerPage: readonly number[];
  readonly progress: number;
  /** The entry open on its own, if one is. */
  readonly openEntry: OpenEntry | undefined;
}

export interface OpenEntry {
  section: string;
  entry: string;
}

export interface FillOptions {
  form: CompiledForm;
  answers: Answers | undefined;
  context: EvaluationContext;
  /** Writes everything typed so far. */
  save: (answers: Record<string, unknown>) => Promise<void>;
  /** Makes an id for a new entry: a UUID. */
  newEntryId: () => string;
}

type Listener = () => void;

export class FillModel {
  readonly form: CompiledForm;
  readonly #context: EvaluationContext;
  readonly #save: FillOptions['save'];
  readonly #newEntryId: FillOptions['newEntryId'];
  #openEntry: OpenEntry | undefined;
  readonly #listeners = new Set<Listener>();
  #state: FormState;
  #pageIndex = 0;
  #reviewing = false;
  #saveStatus: SaveStatus = 'saved';
  #queued: Record<string, unknown> | undefined;
  #saving: Promise<void> | undefined;
  #snapshot: FillSnapshot;

  constructor(options: FillOptions) {
    this.form = options.form;
    this.#context = options.context;
    this.#save = options.save;
    this.#newEntryId = options.newEntryId;
    // A section that needs entries, and has none, opens with that many.
    this.#state = createFormState(options.form, options.answers, {
      newEntryId: options.newEntryId,
    });
    this.#snapshot = this.#build();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  snapshot = (): FillSnapshot => this.#snapshot;

  answer(field: string, value: unknown, entry?: string): Transition {
    return this.#dispatch(
      entry === undefined
        ? { type: 'answer', field, value }
        : { type: 'answer', field, value, entry },
    );
  }

  clear(field: string, entry?: string): Transition {
    return this.#dispatch(
      entry === undefined ? { type: 'clear', field } : { type: 'clear', field, entry },
    );
  }

  touch(field: string, entry?: string): void {
    this.#dispatch(
      entry === undefined ? { type: 'touch', field } : { type: 'touch', field, entry },
    );
  }

  /** Adds an entry to a repeatable section and opens it. */
  addEntry(section: string): Transition {
    const entry = this.#newEntryId();
    const result = this.#dispatch({ type: 'add_entry', section, entry });
    if (result.accepted) {
      this.#openEntry = { section, entry };
      this.#changed();
    }
    return result;
  }

  removeEntry(section: string, entry: string): Transition {
    const result = this.#dispatch({ type: 'remove_entry', section, entry });
    if (result.accepted && this.#openEntry?.entry === entry) {
      this.#openEntry = undefined;
      this.#changed();
    }
    return result;
  }

  moveEntry(section: string, entry: string, index: number): Transition {
    return this.#dispatch({ type: 'move_entry', section, entry, index });
  }

  /** A section of the form, by id. */
  definitionSection(id: string): Section | undefined {
    for (const page of this.form.definition.pages) {
      const found = page.sections.find((section) => section.id === id);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  /** Shows one entry on its own; `undefined` goes back to the page. */
  openEntry(open: OpenEntry | undefined): void {
    this.#openEntry = open;
    this.#changed();
  }

  goToPage(index: number): void {
    if (this.#reviewing) {
      this.#reopen();
    }
    this.#pageIndex = index;
    this.#openEntry = undefined;
    this.#changed();
  }

  next(): void {
    this.goToPage(Math.min(this.#pageIndex + 1, this.#snapshot.pages.length - 1));
  }

  back(): void {
    this.goToPage(Math.max(this.#pageIndex - 1, 0));
  }

  /**
   * Opens the page a question is on — and the entry, for a question asked per
   * entry — and returns the page's index, for the screen to scroll to it.
   */
  goToField(fieldId: string, entry?: string): number {
    const index = pageIndexOfField(this.#snapshot.pages, fieldId);
    this.goToPage(index === -1 ? this.#pageIndex : index);
    const section = this.form.elements.get(fieldId)?.entries;
    if (entry !== undefined && section !== undefined) {
      this.openEntry({ section, entry });
    }
    return this.#pageIndex;
  }

  /**
   * Moves to the review screen when nothing is wrong. Otherwise every problem is
   * shown, the page with the first one opens, and its question is returned.
   */
  review(): { ok: true } | { ok: false; firstField: string | undefined } {
    const result = this.#dispatch({ type: 'submit' });
    if (result.accepted) {
      this.#reviewing = true;
      this.#changed();
      return { ok: true };
    }
    const first = this.#snapshot.problems[0];
    if (first !== undefined) {
      this.goToField(first.field, first.entry);
    }
    return { ok: false, firstField: first?.field };
  }

  /** Back from the review screen to the answers. */
  edit(): void {
    this.#reopen();
    this.#changed();
  }

  /** What is submitted: visible answers only, no calculated values — the engine's rule. */
  submission(): Record<string, unknown> {
    return toSubmission(this.form, this.#state, this.#context);
  }

  /** Waits for every save, retrying one that failed. Rejects if it still cannot save. */
  async flush(): Promise<void> {
    if (this.#saveStatus === 'failed') {
      this.#queued ??= { ...this.#state.answers };
      this.#startSaving();
    }
    await this.#saving;
    if (this.#saveStatus === 'failed') {
      throw new Error('The answers could not be saved on this phone.');
    }
  }

  #reopen(): void {
    if (this.#reviewing) {
      this.#reviewing = false;
      this.#state = transition(this.form, this.#state, { type: 'reopen' }, this.#context).state;
    }
  }

  #dispatch(event: FormEvent): Transition {
    const result = transition(this.form, this.#state, event, this.#context);
    this.#state = result.state;
    if (
      result.accepted &&
      event.type !== 'touch' &&
      event.type !== 'submit' &&
      event.type !== 'reopen'
    ) {
      this.#queued = { ...result.state.answers };
      this.#startSaving();
    }
    this.#changed();
    return result;
  }

  #startSaving(): void {
    if (this.#saving !== undefined) {
      return;
    }
    this.#saveStatus = 'saving';
    this.#saving = (async () => {
      while (this.#queued !== undefined) {
        const answers = this.#queued;
        this.#queued = undefined;
        try {
          await this.#save(answers);
        } catch {
          // Kept for the next change or flush to try again.
          this.#queued ??= answers;
          this.#saveStatus = 'failed';
          this.#saving = undefined;
          this.#changed();
          return;
        }
      }
      this.#saveStatus = 'saved';
      this.#saving = undefined;
      this.#changed();
    })();
  }

  #changed(): void {
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #build(): FillSnapshot {
    const view = viewForm(this.form, this.#state, this.#context);
    const pages = visiblePages(this.form, view);
    const pageIndex = Math.min(this.#pageIndex, Math.max(pages.length - 1, 0));
    const open = this.#openEntry;
    // An entry that has gone — removed, or its section now hidden — is not open.
    const stillOpen =
      open !== undefined &&
      !this.#reviewing &&
      (view.entries.get(open.section) ?? []).some((entry) => entry.id === open.entry)
        ? open
        : undefined;
    return {
      openEntry: stillOpen,
      state: this.#state,
      view,
      pages,
      pageIndex,
      reviewing: this.#reviewing,
      saveStatus: this.#saveStatus,
      problems:
        this.#state.submitAttempted && !this.#reviewing ? firstPerField(view.shownErrors) : [],
      problemsPerPage: problemsPerPage(pages, view),
      progress: progressFraction(view),
    };
  }
}
