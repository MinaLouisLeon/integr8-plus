import { describe, expect, it } from 'vitest';
import { contactEmail, getStartedHref, signupMode } from './signup';

describe('public sign-up switch', () => {
  it('is off unless the build says open, whatever else it says', () => {
    expect(signupMode(undefined)).toBe('off');
    expect(signupMode('')).toBe('off');
    expect(signupMode('on')).toBe('off');
    expect(signupMode('true')).toBe('off');
    expect(signupMode('open')).toBe('open');
  });

  it('sends visitors to the contact page when off, and to the form when open', () => {
    expect(getStartedHref('off')).toBe('/contact');
    expect(getStartedHref('open')).toBe('/sign-up');
  });

  it('never leaves the contact page without an address', () => {
    expect(contactEmail(undefined)).toBe('hello@integr8-media.com');
    expect(contactEmail('   ')).toBe('hello@integr8-media.com');
    expect(contactEmail('sales@example.com')).toBe('sales@example.com');
  });
});
