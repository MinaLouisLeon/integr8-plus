import { describe, expect, it } from 'vitest';
import { compareMigrations, migrationProblems, type MigrationStatus } from './runner.js';
import { checkSchema } from './status.js';

/**
 * The rule that decides whether a rolled-back release may start, without a
 * database. The integration suite proves the same against Postgres.
 *
 * The scenario throughout: this build knows 0001 to 0003; a newer release may
 * have applied more.
 */

const appliedAt = new Date('2026-10-31T03:00:00Z');

function file(version: string, name = `m${version}`) {
  return { version, name, checksum: `sum-${version}` };
}

function row(version: string, name = `m${version}`, checksum = `sum-${version}`) {
  return { version, name, checksum, applied_at: appliedAt };
}

const build = [file('0001'), file('0002'), file('0003')];

function states(statuses: readonly MigrationStatus[]): Record<string, string> {
  return Object.fromEntries(statuses.map((entry) => [entry.version, entry.state]));
}

describe('a schema ahead of the build', () => {
  it('calls migrations newer than every file this build has ahead-of-build, not missing', () => {
    const statuses = compareMigrations(
      [row('0001'), row('0002'), row('0003'), row('0004', 'newer'), row('0005', 'newest')],
      build,
    );

    expect(states(statuses)).toEqual({
      '0001': 'applied',
      '0002': 'applied',
      '0003': 'applied',
      '0004': 'ahead-of-build',
      '0005': 'ahead-of-build',
    });
    expect(statuses.find((entry) => entry.version === '0004')?.name).toBe('newer');
    expect(migrationProblems(statuses)).toEqual([]);
  });

  it('is ready for traffic, with the newer migrations named', () => {
    const check = checkSchema(
      compareMigrations([row('0001'), row('0002'), row('0003'), row('0004', 'newer')], build),
    );

    expect(check.problems).toEqual([]);
    expect(check.aheadOfBuild).toEqual(['0004_newer']);
  });

  it('is a problem when this build also has a migration the newer release never applied', () => {
    // 0003 is this build's own, yet a "newer" release ran 0004 without it: this
    // build is not that release's predecessor.
    const statuses = compareMigrations([row('0001'), row('0002'), row('0004', 'newer')], build);

    expect(states(statuses)).toMatchObject({ '0003': 'pending', '0004': 'ahead-of-build' });
    expect(migrationProblems(statuses)).toEqual([
      '0003_m0003 has not been applied, yet the database already has 0004_newer from a newer release that did not include it',
    ]);
    expect(checkSchema(statuses).problems).toEqual(['0003_m0003 (pending)']);
  });
});

describe('what still fails', () => {
  it('a missing file in the middle is a gap, whatever else is applied', () => {
    const statuses = compareMigrations(
      [row('0001'), row('0002'), row('0003'), row('0004', 'newer')],
      [file('0001'), file('0003')],
    );

    expect(states(statuses)).toMatchObject({ '0002': 'missing-file', '0004': 'ahead-of-build' });
    expect(migrationProblems(statuses)).toEqual(['0002_m0002 was applied but its file is gone']);
    expect(checkSchema(statuses).problems).toEqual(['0002_m0002 (missing-file)']);
  });

  it('an edited migration, even on a schema that is otherwise ahead', () => {
    const statuses = compareMigrations(
      [row('0001'), row('0002', 'm0002', 'edited'), row('0003'), row('0004')],
      build,
    );

    expect(migrationProblems(statuses)).toEqual([
      '0002_m0002 was applied but its file has changed since',
    ]);
    expect(checkSchema(statuses).problems).toEqual(['0002_m0002 (checksum-mismatch)']);
  });

  it('a build with no migration files at all, which is a packaging mistake', () => {
    const statuses = compareMigrations([row('0001')], []);

    expect(states(statuses)).toEqual({ '0001': 'missing-file' });
    expect(migrationProblems(statuses)).toHaveLength(1);
  });

  it('a migration this build has and the database lacks, as before', () => {
    const statuses = compareMigrations([row('0001'), row('0002')], build);

    expect(migrationProblems(statuses)).toEqual([]);
    expect(checkSchema(statuses)).toEqual({
      problems: ['0003_m0003 (pending)'],
      aheadOfBuild: [],
    });
  });
});

describe('an up-to-date schema', () => {
  it('has no problems and nothing ahead', () => {
    const statuses = compareMigrations([row('0001'), row('0002'), row('0003')], build);

    expect(migrationProblems(statuses)).toEqual([]);
    expect(checkSchema(statuses)).toEqual({ problems: [], aheadOfBuild: [] });
  });
});
