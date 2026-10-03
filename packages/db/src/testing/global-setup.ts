import { loadMigrations } from '../migrator/files.js';
import { Migrator } from '../migrator/runner.js';
import { connectAsOwner, requireDisposableDatabase } from './harness.js';

/**
 * Prepares the test database once, before any integration suite runs.
 *
 * It rolls the schema all the way down and back up rather than merely applying
 * what is pending. Two things fall out of that for free, on every CI run:
 * every `down` file is exercised, and the suite starts from a schema built only
 * from migrations — never from a state someone reached by hand.
 */
export default async function setup(): Promise<void> {
  requireDisposableDatabase();

  const client = await connectAsOwner();
  try {
    const migrator = new Migrator(client, loadMigrations());

    const before = await migrator.status();
    const applied = before.filter((entry) => entry.state !== 'pending');

    if (applied.length > 0) {
      const rolledBack = await migrator.down({ to: '0000' });
      console.log(`[db] rolled back ${String(rolledBack.length)} migration(s)`);
    }

    const outcomes = await migrator.up();
    console.log(
      `[db] applied ${String(outcomes.length)} migration(s): ${outcomes
        .map((outcome) => `${outcome.version}_${outcome.name}`)
        .join(', ')}`,
    );
  } finally {
    await client.end();
  }
}
