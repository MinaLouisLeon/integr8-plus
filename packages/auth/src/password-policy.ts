/**
 * The password policy.
 *
 * Length, and nothing that punishes people for using a passphrase.
 *
 * Composition rules — one capital, one digit, one symbol — reliably produce
 * `Password1!` and reliably stop `correct horse battery staple`. They optimise
 * for looking rigorous rather than for entropy, and they push people towards
 * reuse and sticky notes. NIST dropped them in SP 800-63B for exactly that
 * reason and this follows.
 *
 * What is checked instead is the small set of things that genuinely make a
 * password worthless: too short, obviously guessable, or derived from the
 * address it protects.
 *
 * Supabase enforces its own minimum on the way past. This is the one whose
 * message a person actually reads, so it says what is wrong and how to fix it.
 */

export interface PasswordPolicy {
  minLength: number;
}

export interface PasswordAssessment {
  acceptable: boolean;
  /** Human-readable, ready to render. Empty when acceptable. */
  problems: string[];
}

/**
 * A deliberately short list of weak *bases*.
 *
 * Bases rather than whole passwords, because `password`, `password1`,
 * `password123` and `password1234` are one bad idea with a counter on the end.
 * A candidate is stripped of punctuation and trailing digits before it is
 * looked up here, so all four are caught by one entry — and the comparison is
 * an exact match on the base rather than a substring search, so a passphrase
 * that happens to contain `dragon` is left alone.
 *
 * Not a substitute for a breach-corpus check, which belongs behind a service
 * and lands with the security review in P34. This catches the handful that get
 * typed into a demo and then left in production.
 */
const WEAK_BASES = new Set([
  'password',
  'passw0rd',
  'qwerty',
  'qwertyuiop',
  'asdfghjkl',
  'letmein',
  'iloveyou',
  'welcome',
  'admin',
  'administrator',
  'root',
  'changeme',
  'integr8',
  'integr8plus',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'superman',
  'trustno',
  'whatever',
  'master',
  'shadow',
  'secret',
]);

const MAX_LENGTH = 200;

export function assessPassword(
  password: string,
  policy: PasswordPolicy,
  context: { email?: string } = {},
): PasswordAssessment {
  const problems: string[] = [];

  if (password.length < policy.minLength) {
    problems.push(
      `must be at least ${String(policy.minLength)} characters (it is ${String(password.length)})`,
    );
  }

  // An upper bound exists because the password is hashed by the identity
  // provider and an unbounded input is an unbounded amount of work per attempt.
  if (password.length > MAX_LENGTH) {
    problems.push(`must be at most ${String(MAX_LENGTH)} characters`);
  }

  const normalised = password.trim().toLowerCase();

  if (isObvious(normalised)) {
    problems.push('is one of the most commonly used passwords');
  }

  if (normalised !== '' && isRepeated(normalised)) {
    problems.push('is a single character or short pattern repeated');
  }

  if (derivedFromEmail(normalised, context.email)) {
    problems.push('must not contain your email address');
  }

  return { acceptable: problems.length === 0, problems };
}

/**
 * True when the password is built out of the address it protects.
 *
 * Compared with punctuation stripped from both sides, because `dana.okafor`
 * becomes `danaokafor2026` and a literal substring check would miss it —
 * which is the form people actually choose. The local part is also split on
 * its separators, so `okafor-is-great` is caught as well.
 *
 * Fragments shorter than three characters are ignored: refusing every password
 * containing `jo` would refuse most passwords.
 */
function derivedFromEmail(normalisedPassword: string, email: string | undefined): boolean {
  const local = email?.split('@')[0]?.toLowerCase();
  if (local === undefined) {
    return false;
  }

  const stripped = strip(normalisedPassword);
  const fragments = [local, ...local.split(/[.\-_+]/u)]
    .map(strip)
    .filter((fragment) => fragment.length >= 3);

  return fragments.some((fragment) => stripped.includes(fragment));
}

function strip(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

/**
 * True for a well-known password, with or without a counter on the end, and
 * for anything made only of digits.
 */
function isObvious(password: string): boolean {
  const compact = strip(password);

  // Digits only. `123456789012` is long enough to pass the length rule and is
  // still not a password.
  if (compact === '' || /^\d+$/u.test(compact)) {
    return true;
  }

  return WEAK_BASES.has(compact.replace(/\d+$/u, ''));
}

/** True for `aaaaaaaaaaaa`, `abababababab`, `123123123123` and the like. */
function isRepeated(value: string): boolean {
  for (let unit = 1; unit <= Math.floor(value.length / 2); unit += 1) {
    if (value.length % unit !== 0) {
      continue;
    }
    const chunk = value.slice(0, unit);
    if (chunk.repeat(value.length / unit) === value) {
      return true;
    }
  }
  return false;
}
