import { describe, expect, it } from 'vitest';
import { contactEmail } from './contact';

describe('the contact address', () => {
  it('never leaves the contact page without an address', () => {
    expect(contactEmail(undefined)).toBe('hello@integr8-media.com');
    expect(contactEmail('   ')).toBe('hello@integr8-media.com');
    expect(contactEmail('sales@example.com')).toBe('sales@example.com');
  });
});
