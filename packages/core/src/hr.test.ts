import { describe, expect, it } from 'vitest';
import { formatExpenseReference, parseExpenseReference } from './hr.js';

describe('expense references', () => {
  it('format and parse however typed', () => {
    expect(formatExpenseReference(12)).toBe('EX-000012');
    expect(parseExpenseReference('EX-000012')).toBe(12);
    expect(parseExpenseReference('ex12')).toBe(12);
    expect(parseExpenseReference(' 12 ')).toBe(12);
    expect(parseExpenseReference('INV-12')).toBeUndefined();
  });
});
