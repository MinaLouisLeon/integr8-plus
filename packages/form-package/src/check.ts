import {
  checkDesignAgainstForm,
  referencedFileIds,
  type TemplateDesign,
} from '@integr8/document-render';
import {
  compileDefinition,
  type LocalizedText,
  missingTranslations,
  type TextLocation,
} from '@integr8/form-engine';
import { draftDefinition, readDesign, templateName, templatePath } from './contents.js';
import { FormPackageError, type PackageProblem } from './errors.js';

/**
 * What a package (or the content of one about to be packed) would meet in
 * Integr8 Plus beyond being readable: the full compile a form must pass to be
 * published, and every PDF template checked against that form exactly as the
 * API checks a template when it is saved. Each problem names its entry, the
 * place in it, the engine's or designer's code and a sentence — what the forms
 * AI tool hands back to the model writing the file.
 */
export interface FormPackageCheckInput {
  /** The form definition. */
  form: unknown;
  templates?: readonly { name: string; design: unknown }[];
  /** When given, every picture the templates use must be here and every one here used. */
  files?: readonly { id: string }[];
  /** When given, its title is compared with the definition's. */
  manifest?: { form: { title: LocalizedText } };
}

export interface FormPackageCheck {
  /** No problems: the form would publish and every template would save against it. */
  ok: boolean;
  /** What stops publishing or saving a template. */
  problems: PackageProblem[];
  /** What would not stop anything but should be looked at: a missing translation, say. */
  warnings: PackageProblem[];
}

const LANGUAGES: readonly { tag: string; name: string }[] = [
  { tag: 'en', name: 'English' },
  { tag: 'ar', name: 'Arabic' },
];

const problemsOf = (error: unknown): PackageProblem[] => {
  if (error instanceof FormPackageError) {
    return error.problems;
  }
  throw error;
};

const sameText = (a: LocalizedText, b: unknown): boolean => {
  if (typeof b !== 'object' || b === null) {
    return false;
  }
  const other = b as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(other).length && keys.every((key) => a[key] === other[key]);
};

export function checkFormPackage(input: FormPackageCheckInput): FormPackageCheck {
  const problems: PackageProblem[] = [];
  const warnings: PackageProblem[] = [];

  let definition: Record<string, unknown> | undefined;
  try {
    definition = draftDefinition(input.form);
  } catch (error) {
    problems.push(...problemsOf(error));
  }

  const compiled = definition === undefined ? undefined : compileDefinition(definition);
  if (compiled !== undefined && !compiled.ok) {
    problems.push(
      ...compiled.issues.map((issue) => ({
        entry: 'form.json',
        path: issue.path === '' ? 'definition' : `definition.${issue.path}`,
        code: issue.code,
        message: issue.message,
        elements: [...issue.elements],
      })),
    );
  }
  if (compiled?.ok === true) {
    for (const language of LANGUAGES) {
      let missing: TextLocation[];
      try {
        missing = missingTranslations(compiled.form.definition, language.tag);
      } catch {
        missing = [];
      }
      warnings.push(
        ...missing.map((location) => ({
          entry: 'form.json',
          path: location.pathText === '' ? 'definition' : `definition.${location.pathText}`,
          code: 'translation_missing',
          message: `This text has no ${language.name}.`,
        })),
      );
    }
    if (
      input.manifest !== undefined &&
      !sameText(input.manifest.form.title, compiled.form.definition.title)
    ) {
      warnings.push({
        entry: 'manifest.json',
        path: 'form.title',
        code: 'title_mismatch',
        message: 'The manifest’s title differs from the form definition’s title.',
      });
    }
  }

  const designs: (TemplateDesign | undefined)[] = (input.templates ?? []).map((template, index) => {
    const entry = templatePath(index);
    try {
      templateName(template.name, entry);
    } catch (error) {
      problems.push(...problemsOf(error));
    }
    try {
      return readDesign(template.design, entry);
    } catch (error) {
      problems.push(...problemsOf(error));
      return undefined;
    }
  });

  if (compiled?.ok === true) {
    designs.forEach((design, index) => {
      if (design === undefined) {
        return;
      }
      problems.push(
        ...checkDesignAgainstForm(design, compiled.form).map((issue) => ({
          entry: templatePath(index),
          path: issue.path === '' ? 'design' : `design.${issue.path}`,
          code: issue.code,
          message: issue.message,
        })),
      );
    });
  } else if (designs.length > 0) {
    warnings.push({
      entry: 'form.json',
      path: 'definition',
      code: 'templates_not_checked',
      message:
        'The PDF templates were not checked against the form, because the form has problems; fix those first.',
    });
  }

  if (input.files !== undefined) {
    const present = new Set(input.files.map((file) => file.id));
    const used = new Set<string>();
    designs.forEach((design, index) => {
      for (const id of design === undefined ? [] : referencedFileIds(design)) {
        used.add(id);
        if (!present.has(id)) {
          problems.push({
            entry: templatePath(index),
            path: 'design',
            code: 'file_missing',
            message: `The template uses the picture ${id}, which is not among the files.`,
          });
        }
      }
    });
    for (const id of present) {
      if (!used.has(id)) {
        problems.push({
          entry: 'files',
          path: id,
          code: 'file_unused',
          message: `The picture ${id} is used by no PDF template.`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}
