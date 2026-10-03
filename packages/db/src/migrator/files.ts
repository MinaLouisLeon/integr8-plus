import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Discovery and parsing of the migration files.
 *
 * Migrations are ordered `.sql` files on disk, not statements generated from a
 * schema definition. Two reasons, both about the moment things go wrong at
 * 2 a.m.: the exact text that will run against production is the text in the
 * pull request, and a rollback is a file someone wrote and read rather than an
 * inversion someone hopes is correct.
 */

const FILENAME = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.(?<direction>up|down)\.sql$/u;

/** A migration opting out of the wrapping transaction, e.g. `create index concurrently`. */
const NO_TRANSACTION_DIRECTIVE = '-- integr8:no-transaction';

export interface MigrationFile {
  /** Zero-padded ordering key, e.g. `0002`. */
  version: string;
  /** Slug from the filename, e.g. `row_level_security`. */
  name: string;
  up: string;
  down: string;
  upPath: string;
  downPath: string;
  /**
   * SHA-256 of the `up` text, with line endings normalised so a Windows
   * checkout and a Linux CI runner agree.
   */
  checksum: string;
  /** False when the file carries the `no-transaction` directive. */
  useTransaction: boolean;
}

export function defaultMigrationsDir(): string {
  // `../../migrations` from both `src/migrator/` under tsx and `dist/migrator/`
  // after a build.
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export function checksum(text: string): string {
  return createHash('sha256').update(normalise(text)).digest('hex');
}

function normalise(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

/**
 * Reads every migration in `dir`, in version order.
 *
 * Throws on anything ambiguous: a filename that does not parse, a duplicated
 * version, or an `up` with no matching `down`. A rollback that turns out not to
 * exist is discovered here, in CI, rather than during the incident that needs
 * it.
 */
export function loadMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();

  const ups = new Map<string, { name: string; file: string }>();
  const downs = new Map<string, { name: string; file: string }>();

  for (const entry of entries) {
    const match = FILENAME.exec(entry);
    if (match?.groups === undefined) {
      throw new Error(
        `Migration filename "${entry}" does not match NNNN_lower_snake_case.(up|down).sql`,
      );
    }

    const { version, name, direction } = match.groups as {
      version: string;
      name: string;
      direction: 'up' | 'down';
    };

    const target = direction === 'up' ? ups : downs;
    const existing = target.get(version);
    if (existing !== undefined) {
      throw new Error(
        `Two ${direction} migrations share version ${version}: ${existing.file} and ${entry}`,
      );
    }
    target.set(version, { name, file: entry });
  }

  return [...ups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, up]) => {
      const down = downs.get(version);
      if (down === undefined) {
        throw new Error(
          `Migration ${version}_${up.name} has no down file. Every migration must be reversible; write ${version}_${up.name}.down.sql.`,
        );
      }
      if (down.name !== up.name) {
        throw new Error(
          `Migration ${version} is named "${up.name}" going up and "${down.name}" going down.`,
        );
      }

      const upPath = join(dir, up.file);
      const downPath = join(dir, down.file);
      const upText = readFileSync(upPath, 'utf8');

      return {
        version,
        name: up.name,
        up: upText,
        down: readFileSync(downPath, 'utf8'),
        upPath,
        downPath,
        checksum: checksum(upText),
        useTransaction: !normalise(upText).includes(NO_TRANSACTION_DIRECTIVE),
      };
    });
}
