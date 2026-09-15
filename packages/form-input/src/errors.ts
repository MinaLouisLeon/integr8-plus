import type { Field, FieldError } from '@integr8/form-engine';
import { say } from './text.js';

/**
 * The words for an error on a question: the admin's own message for a custom
 * rule or pattern, otherwise the catalogue's message for the engine's code under
 * `form.errors`, with the engine's parameters. `translate` is the app's i18n.
 */
export function errorMessage(
  field: Field,
  error: FieldError,
  locale: string,
  translate: (key: string, params: Record<string, string>) => string,
): string {
  if (error.code === 'rule_failed') {
    const rule = field.rules?.find((candidate) => candidate.id === error.params.rule);
    if (rule !== undefined) {
      return say(rule.message, locale);
    }
  }
  if (
    error.code === 'pattern_mismatch' &&
    field.type === 'text' &&
    field.pattern?.message !== undefined
  ) {
    return say(field.pattern.message, locale);
  }
  return translate(`form.errors.${error.code}`, { ...error.params });
}
