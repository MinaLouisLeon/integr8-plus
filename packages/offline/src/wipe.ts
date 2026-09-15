/**
 * Removing the company's data from the phone.
 *
 * Runs when somebody signs out, and when the server refuses the session because
 * it was revoked — a lost phone reported by the office is wiped the next time it
 * reaches the API, which it tries on launch and whenever it comes back to the
 * foreground.
 *
 * The steps run in the order that makes each one matter less if a later one
 * fails:
 *
 * 1. **Close the database**, so no screen reads another row.
 * 2. **Forget the key.** The database file is SQLCipher-encrypted; without its
 *    key it is noise. If deleting the file then fails, nothing readable is left.
 * 3. **Delete the database file.**
 * 4. **Delete downloaded and pending files.**
 *
 * Every step is attempted even if an earlier one threw, and the failures are
 * returned for reporting — stopping at the first error is how a wipe ends up
 * leaving the photos behind.
 */

export interface WipeSteps {
  closeDatabase(): Promise<void>;
  forgetKey(): Promise<void>;
  deleteDatabase(): Promise<void>;
  deleteFiles(): Promise<void>;
}

export type WipeStep = keyof WipeSteps;

export interface WipeOutcome {
  failures: { step: WipeStep; error: unknown }[];
}

const ORDER: readonly WipeStep[] = ['closeDatabase', 'forgetKey', 'deleteDatabase', 'deleteFiles'];

export async function wipeLocalData(steps: WipeSteps): Promise<WipeOutcome> {
  const failures: WipeOutcome['failures'] = [];
  for (const step of ORDER) {
    try {
      await steps[step]();
    } catch (error) {
      failures.push({ step, error });
    }
  }
  return { failures };
}
