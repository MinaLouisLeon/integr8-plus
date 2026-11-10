import { randomUUID } from 'node:crypto';
import {
  type CompiledForm,
  compileDefinition,
  withRequiredSchemaVersion,
} from '@integr8/form-engine';
import {
  checkFormPackage,
  type FormPackageCheck,
  type FormPackageSettings,
} from '@integr8/form-package';
import type { Picture } from '../mcp/package-files.js';

/**
 * The preview session (P37): what the AI last gave the window and what the
 * person did in it, held in memory for as long as the MCP server runs. One
 * per server. Nothing here touches the disk; printed PDFs go to the scratch
 * folder through the printer (`printer.ts`).
 *
 * Listeners hear "state" whenever the form or templates change and "pdf"
 * whenever a print starts or ends, which is what the page's event stream
 * forwards to the browser.
 */

export interface WindowTemplate {
  name: string;
  design: unknown;
}

export interface WindowContent {
  definition: unknown;
  settings: Partial<FormPackageSettings> | undefined;
  templates: WindowTemplate[];
  pictures: Picture[];
}

export type WindowTab = 'form' | 'pdf' | 'checks';

export interface WindowView {
  tab: WindowTab;
  language: 'en' | 'ar';
  width: 'phone' | 'desktop';
  theme: 'light' | 'dark';
}

export interface PrintOptions {
  /** The answers typed in the Form tab, or generated sample answers. */
  useAnswers: boolean;
  /** Undefined: the template's own language. */
  language: 'en' | 'ar' | undefined;
  companyColour: string | undefined;
}

export interface PrintRecord {
  status: 'waiting' | 'printing' | 'ready' | 'failed' | 'unavailable';
  /** The content version the print was made from. */
  version: number;
  options: PrintOptions;
  /** Who asked: the window, or the AI through preview_pdf. */
  by: 'window' | 'ai';
  at: string;
  message?: string;
  pdfPath?: string;
  pageCount?: number;
}

export interface WindowNote {
  id: string;
  at: string;
  tab: WindowTab;
  /** A question id, or a template's name, the note is about. */
  about: string | undefined;
  text: string;
  read: boolean;
  /** Sent with "Suggest a change to the platform" (P39): the AI offers a change request. */
  platform: boolean;
}

export interface SubmitRecord {
  at: string;
  /** What the app would send: visible answers, no calculated values. */
  answers: Record<string, unknown>;
}

export interface StoredMedia {
  contentType: string;
  bytes: Uint8Array;
}

export type SessionEvent = { type: 'state'; version: number } | { type: 'pdf'; template: number };

/** At most this many notes are kept; the oldest read ones go first. */
const MAX_NOTES = 200;
/** Photos and signatures typed in the window, all together. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

function compiled(definition: unknown): CompiledForm | undefined {
  const result = compileDefinition(withRequiredSchemaVersion(definition));
  return result.ok ? result.form : undefined;
}

function filterValues(
  values: Record<string, unknown>,
  before: CompiledForm | undefined,
  after: CompiledForm,
  section: string | undefined,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const now = after.elements.get(id);
    const then = before?.elements.get(id);
    if (now === undefined || now.entries !== section) {
      continue;
    }
    if (now.repeat !== undefined) {
      if ((before !== undefined && then?.repeat === undefined) || !Array.isArray(value)) {
        continue;
      }
      kept[id] = (value as unknown[]).flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return [];
        }
        const { id: entryId, values: entryValues } = entry as { id?: unknown; values?: unknown };
        if (
          typeof entryId !== 'string' ||
          typeof entryValues !== 'object' ||
          entryValues === null
        ) {
          return [];
        }
        return [
          {
            id: entryId,
            values: filterValues(entryValues as Record<string, unknown>, before, after, id),
          },
        ];
      });
      continue;
    }
    if (now.field === undefined || (before !== undefined && then?.field?.type !== now.field.type)) {
      continue;
    }
    kept[id] = value;
  }
  return kept;
}

/**
 * The answers that survive a change of form: those of questions that still
 * exist, with the same type, in the same place (top level, or the same
 * repeating section). Without a new form that compiles nothing can be
 * matched, so the answers are kept as they are until one does; when only the
 * old one did not compile, types cannot be compared and the place decides.
 */
export function keepAnswers(
  answers: Record<string, unknown>,
  before: unknown,
  after: unknown,
): Record<string, unknown> {
  const next = compiled(after);
  if (next === undefined) {
    return answers;
  }
  return filterValues(answers, compiled(before), next, undefined);
}

export class PreviewSession {
  #content: WindowContent | undefined;
  #check: FormPackageCheck | undefined;
  #version = 0;
  #answers: Record<string, unknown> = {};
  #submitted: SubmitRecord | undefined;
  #notes: WindowNote[] = [];
  #view: WindowView = { tab: 'form', language: 'en', width: 'desktop', theme: 'light' };
  #prints = new Map<number, PrintRecord>();
  #media = new Map<string, StoredMedia>();
  #mediaBytes = 0;
  #listeners = new Set<(event: SessionEvent) => void>();

  get content(): WindowContent | undefined {
    return this.#content;
  }

  get check(): FormPackageCheck | undefined {
    return this.#check;
  }

  get version(): number {
    return this.#version;
  }

  get answers(): Record<string, unknown> {
    return this.#answers;
  }

  get submitted(): SubmitRecord | undefined {
    return this.#submitted;
  }

  get view(): WindowView {
    return this.#view;
  }

  get notes(): readonly WindowNote[] {
    return this.#notes;
  }

  print(template: number): PrintRecord | undefined {
    return this.#prints.get(template);
  }

  get prints(): ReadonlyMap<number, PrintRecord> {
    return this.#prints;
  }

  media(id: string): StoredMedia | undefined {
    return this.#media.get(id);
  }

  /** Every stored photo or signature as a data URI, for printing. */
  mediaDataUris(): Record<string, string> {
    const uris: Record<string, string> = {};
    for (const [id, media] of this.#media) {
      uris[id] = `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`;
    }
    return uris;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  /**
   * Replaces what the AI gave, wholly or in part: a part left undefined stays
   * as it was. Typed answers are kept where their question still exists with
   * the same type; prints of templates that changed are dropped.
   */
  update(change: Partial<WindowContent>): FormPackageCheck {
    const before = this.#content;
    if (before === undefined && change.definition === undefined) {
      throw new Error('There is no form in the preview yet; give its definition.');
    }
    const next: WindowContent = {
      definition: change.definition ?? before?.definition,
      settings: change.settings ?? before?.settings,
      templates: change.templates ?? before?.templates ?? [],
      pictures: change.pictures ?? before?.pictures ?? [],
    };
    if (before !== undefined && change.definition !== undefined) {
      this.#answers = keepAnswers(this.#answers, before.definition, next.definition);
    }
    const formChanged =
      before === undefined ||
      JSON.stringify(before.definition) !== JSON.stringify(next.definition) ||
      change.pictures !== undefined;
    for (const [index, record] of [...this.#prints]) {
      const old = before?.templates[index];
      const now = next.templates[index];
      if (
        formChanged ||
        now === undefined ||
        old?.name !== now.name ||
        JSON.stringify(old.design) !== JSON.stringify(now.design)
      ) {
        if (record.status !== 'printing') {
          this.#prints.delete(index);
        }
      }
    }
    this.#content = next;
    this.#check = checkFormPackage({
      form: next.definition,
      templates: next.templates,
      files: next.pictures,
    });
    this.#version += 1;
    this.#emit({ type: 'state', version: this.#version });
    return this.#check;
  }

  setAnswers(answers: Record<string, unknown>): void {
    this.#answers = answers;
  }

  setSubmitted(answers: Record<string, unknown>, at = new Date()): void {
    this.#submitted = { at: at.toISOString(), answers };
  }

  setView(view: Partial<WindowView>): void {
    this.#view = { ...this.#view, ...view };
  }

  addNote(note: {
    tab: WindowTab;
    about: string | undefined;
    text: string;
    platform?: boolean;
  }): WindowNote {
    const stored: WindowNote = {
      id: randomUUID(),
      at: new Date().toISOString(),
      tab: note.tab,
      about: note.about,
      text: note.text,
      read: false,
      platform: note.platform === true,
    };
    this.#notes.push(stored);
    while (this.#notes.length > MAX_NOTES) {
      const oldestRead = this.#notes.findIndex((candidate) => candidate.read);
      this.#notes.splice(oldestRead === -1 ? 0 : oldestRead, 1);
    }
    return stored;
  }

  /** The notes the AI has not read yet, marked read. */
  takeUnreadNotes(): WindowNote[] {
    const unread = this.#notes.filter((note) => !note.read);
    for (const note of unread) {
      note.read = true;
    }
    return unread.map((note) => ({ ...note }));
  }

  /** Stores a photo or signature; undefined when the window's share is used up. */
  addMedia(media: StoredMedia): string | undefined {
    if (this.#mediaBytes + media.bytes.length > MAX_MEDIA_BYTES) {
      return undefined;
    }
    const id = randomUUID();
    this.#media.set(id, media);
    this.#mediaBytes += media.bytes.length;
    return id;
  }

  clearPrint(template: number): void {
    if (this.#prints.delete(template)) {
      this.#emit({ type: 'pdf', template });
    }
  }

  setPrint(template: number, record: PrintRecord): void {
    this.#prints.set(template, record);
    this.#emit({ type: 'pdf', template });
  }
}
