import { FIELD_ERROR_CODES } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { en } from './messages/en.js';

/**
 * The form engine's error codes are a contract with this catalogue.
 *
 * The engine decides *that* an answer is wrong and why, as a code. The words are
 * here. A code with no message renders as a raw key in front of a field
 * engineer, and nothing else in the build would notice.
 */
describe('form error messages', () => {
  it('has a message for every error code the form engine can produce', () => {
    const missing = FIELD_ERROR_CODES.filter((code) => !(code in en.form.errors));
    expect(missing).toEqual([]);
  });

  it('has no message for a code the engine no longer produces', () => {
    const known: readonly string[] = FIELD_ERROR_CODES;
    expect(Object.keys(en.form.errors).filter((code) => !known.includes(code))).toEqual([]);
  });

  it('interpolates only the parameters the engine sends', () => {
    const parameters = new Set(['minimum', 'maximum', 'earliest', 'latest', 'rule']);
    for (const message of Object.values(en.form.errors)) {
      for (const [, name] of message.matchAll(/\{\{(\w+)\}\}/gu)) {
        expect(
          parameters.has(name ?? ''),
          `unknown parameter {{${name ?? ''}}} in "${message}"`,
        ).toBe(true);
      }
    }
  });
});
