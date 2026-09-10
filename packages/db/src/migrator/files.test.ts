import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksum, defaultMigrationsDir, loadMigrations } from './files.js';

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'integr8-migrations-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf8');
  }
  return dir;
}

describe('loading', () => {
  it('returns migrations in version order regardless of directory order', () => {
    const dir = scratch({
      '0010_later.up.sql': 'select 1;',
      '0010_later.down.sql': 'select 1;',
      '0002_middle.up.sql': 'select 1;',
      '0002_middle.down.sql': 'select 1;',
      '0001_first.up.sql': 'select 1;',
      '0001_first.down.sql': 'select 1;',
    });

    expect(loadMigrations(dir).map((migration) => migration.version)).toEqual([
      '0001',
      '0002',
      '0010',
    ]);
  });

  it('rejects an up with no down, because a rollback nobody wrote is not a rollback', () => {
    const dir = scratch({ '0001_first.up.sql': 'select 1;' });
    expect(() => loadMigrations(dir)).toThrow(/has no down file/u);
  });

  it('rejects a filename that does not parse', () => {
    const dir = scratch({ 'add-tenants.sql': 'select 1;' });
    expect(() => loadMigrations(dir)).toThrow(/does not match/u);
  });

  it('rejects two migrations claiming the same version', () => {
    const dir = scratch({
      '0001_first.up.sql': 'select 1;',
      '0001_first.down.sql': 'select 1;',
      '0001_other.up.sql': 'select 1;',
      '0001_other.down.sql': 'select 1;',
    });

    expect(() => loadMigrations(dir)).toThrow(/share version 0001/u);
  });

  it('rejects an up and down that disagree about the name', () => {
    const dir = scratch({
      '0001_first.up.sql': 'select 1;',
      '0001_second.down.sql': 'select 1;',
    });

    expect(() => loadMigrations(dir)).toThrow(/named "first" going up/u);
  });
});

describe('checksums', () => {
  it('ignores line-ending differences between a Windows checkout and Linux CI', () => {
    expect(checksum('create table t ();\nselect 1;\n')).toBe(
      checksum('create table t ();\r\nselect 1;\r\n'),
    );
  });

  it('changes when the SQL changes', () => {
    expect(checksum('select 1;')).not.toBe(checksum('select 2;'));
  });
});

describe('the no-transaction directive', () => {
  it('is off by default', () => {
    const dir = scratch({
      '0001_first.up.sql': 'create table t ();',
      '0001_first.down.sql': 'drop table t;',
    });

    expect(loadMigrations(dir)[0]?.useTransaction).toBe(true);
  });

  it('is honoured when present', () => {
    const dir = scratch({
      '0001_first.up.sql': '-- integr8:no-transaction\ncreate index concurrently i on t (a);',
      '0001_first.down.sql': 'drop index i;',
    });

    expect(loadMigrations(dir)[0]?.useTransaction).toBe(false);
  });
});

describe('this package', () => {
  it('has migrations that all load, in order, each with a down', () => {
    const migrations = loadMigrations(defaultMigrationsDir());

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.version)).toEqual(
      [...migrations].map((migration) => migration.version).sort((a, b) => a.localeCompare(b)),
    );
    for (const migration of migrations) {
      expect(migration.down.trim()).not.toBe('');
    }
  });
});
