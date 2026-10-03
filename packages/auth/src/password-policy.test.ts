import { describe, expect, it } from 'vitest';
import { assessPassword } from './password-policy.js';

const POLICY = { minLength: 12 };

function accepts(password: string, email?: string): boolean {
  return assessPassword(password, POLICY, email === undefined ? {} : { email }).acceptable;
}

describe('length', () => {
  it('rejects anything shorter than the minimum', () => {
    expect(accepts('short')).toBe(false);
    expect(accepts('elevenchars')).toBe(false);
  });

  it('accepts exactly the minimum', () => {
    expect(accepts('twelvechars!')).toBe(true);
  });

  it('says how short it was, so the message is actionable', () => {
    const { problems } = assessPassword('abc', POLICY);
    expect(problems[0]).toContain('at least 12');
    expect(problems[0]).toContain('it is 3');
  });

  it('rejects something absurdly long', () => {
    // The identity provider hashes it, so an unbounded input is unbounded work
    // per attempt.
    expect(accepts('a1b2c3d4e5'.repeat(30))).toBe(false);
  });
});

describe('what it deliberately does not require', () => {
  /**
   * No composition rules. They reliably produce `Password1!` and reliably block
   * `correct horse battery staple`, which is the wrong way round. NIST dropped
   * them in SP 800-63B and so does this.
   */
  it('accepts a passphrase with no digits, capitals or symbols', () => {
    expect(accepts('correct horse battery staple')).toBe(true);
  });

  it('accepts a long string of one case', () => {
    expect(accepts('thequickbrownfoxjumps')).toBe(true);
  });

  it('does not reward `Password1!`', () => {
    // Long enough and has all four character classes — and still refused,
    // because what makes it bad is that everyone uses it.
    expect(accepts('password123')).toBe(false);
  });
});

describe('obviously guessable', () => {
  it('rejects the common ones regardless of case', () => {
    expect(accepts('password1234')).toBe(false);
    expect(accepts('PASSWORD123')).toBe(false);
    expect(accepts('ChangeMe123')).toBe(false);
  });

  it('rejects a single character repeated', () => {
    expect(accepts('aaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('rejects a short pattern repeated', () => {
    expect(accepts('abababababababab')).toBe(false);
    expect(accepts('123123123123')).toBe(false);
  });

  it('does not mistake a long passphrase for a repeated pattern', () => {
    expect(accepts('the north wind and the sun')).toBe(true);
  });
});

describe('the email address it protects', () => {
  it('rejects a password containing the local part', () => {
    expect(accepts('danaokafor2026', 'dana.okafor@northwind.example')).toBe(false);
  });

  it('is case-insensitive about it', () => {
    expect(accepts('DanaOkafor2026x', 'dana.okafor@northwind.example')).toBe(false);
  });

  it('ignores a local part too short to be meaningful', () => {
    // Refusing every password containing "jo" would refuse most of them.
    expect(accepts('a joyful morning in may', 'jo@northwind.example')).toBe(true);
  });

  it('accepts an unrelated password for the same address', () => {
    expect(accepts('the north wind and the sun', 'dana.okafor@northwind.example')).toBe(true);
  });
});

describe('the report', () => {
  it('is empty when the password is acceptable', () => {
    expect(assessPassword('correct horse battery staple', POLICY).problems).toEqual([]);
  });

  it('lists every problem at once rather than one per attempt', () => {
    const { problems } = assessPassword('dana', POLICY, { email: 'dana.okafor@x.example' });

    expect(problems.length).toBeGreaterThan(1);
    expect(problems.some((problem) => problem.includes('at least 12'))).toBe(true);
    expect(problems.some((problem) => problem.includes('email address'))).toBe(true);
  });
});
