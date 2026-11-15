import type { IdentityProvider } from '@integr8/auth';
import {
  existingSignInAccounts,
  exportCompanyRows,
  getPlatformDataSource,
  importCompanyRows,
  readSignInAccounts,
  schemaVersion,
  type TableHeader,
  TRANSFER_FORMAT_VERSION,
  TransferRefusedError,
  type WriteReport,
} from '@integr8/db';
import { VERSION } from '../app-info.js';
import type { MediaStorage } from '../media/storage.js';
import { getStorage, provisionTenantStorage } from '../media/tenant-storage.js';
import { type ArchiveEntry, ArchiveError, ArchiveWriter, readArchive } from './archive.js';

/**
 * Moving one company from one Integr8 server to another (P41). Staff only.
 *
 * The archive, in the order it is written and read:
 *
 *   manifest.json                  what this is: format, release, schema, company, modules, tables
 *   tables/<table>/<n>.ndjson      the rows, a batch per entry, one JSON row per line
 *   tables/<table>/count           how many rows the table had, checked before the import commits
 *   accounts.ndjson                the people's sign-in accounts with password hashes (optional)
 *   files.ndjson                   every stored object: key, type, size (optional)
 *   files/<key>                    each object's bytes
 *
 * The rows are written in one transaction on the new server, with every
 * foreign key checked before it commits; the files and accounts follow, and
 * both steps skip what is already there, so `--continue` finishes an import
 * that stopped after its rows.
 *
 * Compatibility: an archive records the format and the schema it was made
 * with. A server reads any older format (through {@link UPGRADES}) and any
 * older schema (columns are matched by name; see `writeCompany`), and refuses
 * a newer one rather than guessing.
 */

export const MANIFEST_FORMAT = 'integr8-company-transfer';

export interface TransferManifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: number;
  release: string;
  schemaVersion: string;
  exportedAt: string;
  company: { id: string; slug: string; name: string };
  includes: { files: boolean; passwords: boolean };
  /** Module (the migration that creates the tables) → its tables, for a person reading the archive. */
  modules: Record<string, string[]>;
  tables: TableHeader[];
}

/**
 * Steps that bring an archive of an older format up to this one, keyed by the
 * format they read. Empty while there is one format; a change to the layout
 * above adds the step from the previous number here and raises
 * `TRANSFER_FORMAT_VERSION`, so every archive ever made still imports.
 */
export const UPGRADES: Readonly<Record<number, (manifest: TransferManifest) => TransferManifest>> =
  {};

export interface ExportOptions {
  adminConnectionString: string;
  media: MediaStorage;
  tenantId: string;
  out: string;
  withFiles: boolean;
  withPasswords: boolean;
  now?: Date;
}

export interface ExportReport {
  rows: number;
  tables: number;
  files: number;
  fileBytes: number;
  accounts: number;
}

export async function exportCompany(options: ExportOptions): Promise<ExportReport> {
  const platform = getPlatformDataSource();
  const tenant = await platform.tenants.findById(options.tenantId);
  if (tenant === undefined) {
    throw new TransferRefusedError(`There is no company ${options.tenantId} on this server.`);
  }

  const writer = new ArchiveWriter(options.out);
  const report: ExportReport = { rows: 0, tables: 0, files: 0, fileBytes: 0, accounts: 0 };
  try {
    // The manifest goes first, so an import can refuse an archive before it
    // reads any rows; the reader names the tables before the first batch.
    const chunks = new Map<string, number>();
    const counts = new Map<string, number>();
    // Every table ends with its count, in the manifest's order, empty ones
    // included, so an import can tell "no rows" from "rows lost".
    let order: string[] = [];
    let closed = 0;
    const closeTablesBefore = async (name: string | undefined) => {
      while (closed < order.length && order[closed] !== name) {
        const table = order[closed] ?? '';
        await writer.add(`tables/${table}/count`, String(counts.get(table) ?? 0));
        closed += 1;
      }
    };

    const { tables } = await exportCompanyRows(
      options.adminConnectionString,
      options.tenantId,
      async (table, lines) => {
        await closeTablesBefore(table.name);
        const n = (chunks.get(table.name) ?? 0) + 1;
        chunks.set(table.name, n);
        counts.set(table.name, (counts.get(table.name) ?? 0) + lines.length);
        await writer.add(
          `tables/${table.name}/${String(n).padStart(6, '0')}.ndjson`,
          `${lines.join('\n')}\n`,
        );
      },
      async (tableList) => {
        order = tableList.map((table) => table.name);
        const modules: Record<string, string[]> = {};
        for (const table of tableList) {
          (modules[table.module] ??= []).push(table.name);
        }
        const manifest: TransferManifest = {
          format: MANIFEST_FORMAT,
          formatVersion: TRANSFER_FORMAT_VERSION,
          release: VERSION,
          schemaVersion: schemaVersion(),
          exportedAt: (options.now ?? new Date()).toISOString(),
          company: { id: tenant.id, slug: tenant.slug, name: tenant.name },
          includes: { files: options.withFiles, passwords: options.withPasswords },
          modules,
          tables: tableList.map((table) => ({
            name: table.name,
            module: table.module,
            columns: table.columns,
          })),
        };
        await writer.add('manifest.json', JSON.stringify(manifest, null, 2));
      },
    );
    await closeTablesBefore(undefined);
    report.tables = tables.length;
    report.rows = [...counts.values()].reduce((sum, n) => sum + n, 0);

    if (options.withPasswords) {
      const accounts = await readSignInAccounts(options.adminConnectionString, options.tenantId);
      await writer.add(
        'accounts.ndjson',
        accounts.map((account) => JSON.stringify(account)).join('\n') +
          (accounts.length > 0 ? '\n' : ''),
      );
      report.accounts = accounts.length;
    }

    if (options.withFiles) {
      const store = await getStorage(options.media, options.tenantId);
      const index: { key: string; contentType: string; byteSize: number }[] = [];
      for await (const object of store.list()) {
        const head = await store.head(object.key);
        if (head !== undefined) {
          index.push({ key: object.key, contentType: head.contentType, byteSize: head.byteSize });
        }
      }
      await writer.add('files.ndjson', index.map((entry) => JSON.stringify(entry)).join('\n'));
      for (const entry of index) {
        const body = await store.get(entry.key);
        if (body === undefined) continue;
        await writer.add(`files/${entry.key}`, body);
        report.files += 1;
        report.fileBytes += body.byteLength;
      }
    }
  } finally {
    await writer.close();
  }
  return report;
}

export interface ImportOptions {
  adminConnectionString: string;
  media: MediaStorage;
  identity: IdentityProvider;
  file: string;
  /** The rows are already here from an earlier run: only finish the files and accounts. */
  continueAfterRows?: boolean;
}

export interface ImportReport {
  manifest: TransferManifest;
  rows: WriteReport | undefined;
  files: { uploaded: number; alreadyThere: number };
  accounts: { created: number; alreadyThere: number };
}

/** Reads the manifest only, for `transfer inspect` and to refuse early. */
export async function inspectArchive(file: string): Promise<TransferManifest> {
  for await (const entry of readArchive(file)) {
    return parseManifest(entry);
  }
  throw new ArchiveError('The archive is empty.');
}

export async function importCompany(options: ImportOptions): Promise<ImportReport> {
  const entries = peekable(readArchive(options.file)[Symbol.asyncIterator]());
  const first = await entries.next();
  if (first === undefined) {
    throw new ArchiveError('The archive is empty.');
  }
  const manifest = parseManifest(first);
  const tenantId = manifest.company.id;

  // Rows: one table after another, each closed by its count.
  let rows: WriteReport | undefined;
  if (options.continueAfterRows === true) {
    const here = await getPlatformDataSource().tenants.findById(tenantId);
    if (here === undefined) {
      throw new TransferRefusedError(
        `Company ${manifest.company.slug} is not on this server yet: import without --continue.`,
      );
    }
    while ((await entries.peek())?.name.startsWith('tables/') === true) await entries.next();
  } else {
    rows = await importCompanyRows(options.adminConnectionString, {
      tenantId,
      tables: manifest.tables,
      rows: (header) => tableRows(entries, header.name),
    });
  }

  const report: ImportReport = {
    manifest,
    rows,
    files: { uploaded: 0, alreadyThere: 0 },
    accounts: { created: 0, alreadyThere: 0 },
  };

  // Sign-in accounts, keeping each person's id and password.
  if ((await entries.peek())?.name === 'accounts.ndjson') {
    const entry = await entries.next();
    const accounts = lines(entry?.body).map(
      (line) => JSON.parse(line) as { userId: string; email: string; passwordHash: string | null },
    );
    const present = new Set(
      await existingSignInAccounts(
        options.adminConnectionString,
        accounts.map((account) => account.userId),
      ),
    );
    for (const account of accounts) {
      if (present.has(account.userId)) {
        report.accounts.alreadyThere += 1;
        continue;
      }
      await options.identity.importIdentity(account);
      report.accounts.created += 1;
    }
  }

  // Files, into storage this server provisions for the company.
  if ((await entries.peek())?.name === 'files.ndjson') {
    const indexEntry = await entries.next();
    const index = new Map(
      lines(indexEntry?.body).map((line) => {
        const entry = JSON.parse(line) as { key: string; contentType: string };
        return [entry.key, entry.contentType] as const;
      }),
    );
    await provisionTenantStorage(options.media, tenantId);
    const store = await getStorage(options.media, tenantId);
    for (;;) {
      const entry = await entries.next();
      if (entry === undefined) break;
      if (!entry.name.startsWith('files/')) {
        throw new ArchiveError(`Unexpected entry "${entry.name}" among the files.`);
      }
      const key = entry.name.slice('files/'.length);
      if ((await store.head(key)) !== undefined) {
        report.files.alreadyThere += 1;
        continue;
      }
      await store.put({
        key,
        body: entry.body,
        contentType: index.get(key) ?? 'application/octet-stream',
      });
      report.files.uploaded += 1;
    }
  }

  await getPlatformDataSource().platformAudit.append({
    platformUserId: null,
    actorLabel: 'transfer command',
    action: 'company.imported',
    tenantId,
    tenantSlug: manifest.company.slug,
    metadata: {
      release: manifest.release,
      schemaVersion: manifest.schemaVersion,
      exportedAt: manifest.exportedAt,
      files: report.files,
      accounts: report.accounts,
      continued: options.continueAfterRows === true,
    },
  });
  return report;
}

function parseManifest(entry: ArchiveEntry): TransferManifest {
  if (entry.name !== 'manifest.json') {
    throw new ArchiveError('This is not a company transfer: it does not start with manifest.json.');
  }
  let manifest = JSON.parse(entry.body.toString('utf8')) as TransferManifest;
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new ArchiveError('This is not a company transfer.');
  }
  if (manifest.formatVersion > TRANSFER_FORMAT_VERSION) {
    throw new TransferRefusedError(
      `The archive was made by a newer release (${manifest.release}, format ${String(manifest.formatVersion)}). Update this server first.`,
    );
  }
  if (manifest.schemaVersion > schemaVersion()) {
    throw new TransferRefusedError(
      `The archive's schema (${manifest.schemaVersion}, release ${manifest.release}) is newer than this server's (${schemaVersion()}). Update this server first.`,
    );
  }
  for (let version = manifest.formatVersion; version < TRANSFER_FORMAT_VERSION; version += 1) {
    const step = UPGRADES[version];
    if (step === undefined) {
      throw new TransferRefusedError(`No upgrade from transfer format ${String(version)}.`);
    }
    manifest = step(manifest);
  }
  return manifest;
}

/** A table's batches, ending at its count entry, which must match what was read. */
async function* tableRows(entries: Peekable<ArchiveEntry>, table: string): AsyncIterable<string[]> {
  const prefix = `tables/${table}/`;
  let read = 0;
  for (;;) {
    const entry = await entries.next();
    if (!entry?.name.startsWith(prefix)) {
      throw new ArchiveError(`The archive ends ${table} without its count: it is incomplete.`);
    }
    if (entry.name === `${prefix}count`) {
      const expected = Number(entry.body.toString('utf8'));
      if (expected !== read) {
        throw new ArchiveError(
          `${table} should have ${String(expected)} rows and has ${String(read)}.`,
        );
      }
      return;
    }
    const batch = lines(entry.body);
    read += batch.length;
    yield batch;
  }
}

function lines(body: Buffer | undefined): string[] {
  return (body?.toString('utf8') ?? '').split('\n').filter((line) => line !== '');
}

interface Peekable<T> {
  next(): Promise<T | undefined>;
  peek(): Promise<T | undefined>;
}

function peekable<T>(iterator: AsyncIterator<T>): Peekable<T> {
  let buffered: { value: T | undefined } | undefined;
  const pull = async (): Promise<T | undefined> => {
    const result = await iterator.next();
    return result.done === true ? undefined : result.value;
  };
  return {
    async next() {
      if (buffered !== undefined) {
        const { value } = buffered;
        buffered = undefined;
        return value;
      }
      return pull();
    },
    async peek() {
      buffered ??= { value: await pull() };
      return buffered.value;
    },
  };
}
