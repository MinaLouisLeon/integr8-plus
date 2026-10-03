import {
  CUSTOMER_STATUSES,
  type CustomerStatus,
  type ImportKind,
  type ImportRowError,
  type JobType,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { WORK_ORDER_PRIORITIES, type WorkOrderPriority } from '@integr8/core';
import type { Logger } from '../http/logger.js';
import { GEOCODE_QUEUE } from '../geo/geocode-site.js';
import { CsvSyntaxError, normaliseHeader, parseCsv } from './csv.js';
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS } from './definitions.js';
import { parseZonedDateTime } from './zoned-time.js';

export const IMPORT_QUEUE = 'import.run';

/** How often progress is written back, in rows. */
const PROGRESS_EVERY = 50;

type Row = Record<string, string>;

interface Problem {
  column: string | null;
  code: string;
  message: string;
}

/** A row that cannot be imported, for every reason found — not only the first. */
class RowRefused extends Error {
  constructor(readonly problems: Problem[]) {
    super(problems.map((problem) => problem.message).join(' '));
  }
}

interface ImportContext {
  tenantId: string;
  actor: string;
  timeZone: string;
  jobTypes: JobType[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Runs one import from its stored CSV.
 *
 * Every data row is validated and written in its own transaction, so a bad row
 * is reported with its spreadsheet row number and the reason, and the rest of
 * the file carries on. A file that cannot be read at all — broken quoting, a
 * required column missing, too many rows — fails as a whole, before any row is
 * written.
 */
export async function runImport(options: {
  tenantId: string;
  importId: string;
  timeZone: string;
  logger: Logger;
}): Promise<'completed' | 'failed' | 'skipped'> {
  const { tenantId, importId, logger } = options;
  const loaded = await withTenant(tenantId, async (tx) => ({
    record: await tx.imports.find(importId),
    source: await tx.imports.source(importId),
  }));
  if (loaded.record?.status !== 'pending' || loaded.source === undefined) {
    return 'skipped';
  }
  const { record, source } = loaded;

  const fail = async (problem: ImportRowError) => {
    await withTenant(tenantId, async (tx) => {
      await tx.imports.start(importId, 0);
      await tx.imports.finish(importId, 'failed', [problem]);
    });
    return 'failed' as const;
  };

  let rows;
  try {
    rows = parseCsv(source);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      return fail({ row: error.row, column: null, code: 'csv_syntax', message: error.message });
    }
    throw error;
  }
  const [header, ...data] = rows;
  if (header === undefined) {
    return fail({
      row: 1,
      column: null,
      code: 'empty_file',
      message: 'The file has no header row.',
    });
  }

  const columns = IMPORT_COLUMNS[record.kind];
  const names = header.cells.map(normaliseHeader);
  const known = new Set(columns.map((column) => column.name));
  const missing = columns.filter((column) => column.required && !names.includes(column.name));
  if (missing.length > 0) {
    return fail({
      row: 1,
      column: missing[0]!.name,
      code: 'missing_column',
      message: `The header has no ${missing.map((column) => column.name).join(', ')} column.`,
    });
  }
  if (data.length > MAX_IMPORT_ROWS) {
    return fail({
      row: 1,
      column: null,
      code: 'too_many_rows',
      message: `The file has ${String(data.length)} rows; an import takes at most ${String(MAX_IMPORT_ROWS)}. Split it into several files.`,
    });
  }

  const started = await withTenant(tenantId, (tx) => tx.imports.start(importId, data.length));
  if (!started) {
    return 'skipped';
  }

  const headerErrors: ImportRowError[] = names
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name !== '' && !known.has(name))
    .map(({ name, index }) => ({
      row: 1,
      column: header.cells[index] ?? name,
      code: 'unknown_column',
      message: `Column "${header.cells[index] ?? name}" is not one this import reads, so it was ignored.`,
    }));

  const context: ImportContext = {
    tenantId,
    actor: record.createdBy,
    timeZone: options.timeZone,
    jobTypes: await withTenant(tenantId, (tx) => tx.jobTypes.list()),
  };

  let batch = { succeeded: 0, failed: 0, errors: [...headerErrors] };
  const flush = async () => {
    if (batch.succeeded + batch.failed + batch.errors.length === 0) {
      return;
    }
    const sending = batch;
    batch = { succeeded: 0, failed: 0, errors: [] };
    await withTenant(tenantId, (tx) => tx.imports.recordProgress(importId, sending));
  };

  for (const [position, line] of data.entries()) {
    const row: Row = {};
    names.forEach((name, index) => {
      if (known.has(name)) {
        row[name] = (line.cells[index] ?? '').trim();
      }
    });

    try {
      await withTenant(tenantId, (tx) => IMPORTERS[record.kind](tx, row, context));
      batch.succeeded += 1;
    } catch (error) {
      batch.failed += 1;
      if (error instanceof RowRefused) {
        batch.errors.push(...error.problems.map((problem) => ({ row: line.row, ...problem })));
      } else {
        const refusal = databaseRefusal(error);
        if (refusal === undefined) {
          logger.error('Import row failed unexpectedly', {
            importId,
            row: line.row,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        batch.errors.push({
          row: line.row,
          column: refusal?.column ?? null,
          code: refusal?.code ?? 'unexpected',
          message: refusal?.message ?? 'This row could not be saved. Nothing from it was imported.',
        });
      }
    }
    if ((position + 1) % PROGRESS_EVERY === 0) {
      await flush();
    }
  }
  await flush();
  await withTenant(tenantId, (tx) => tx.imports.finish(importId, 'completed'));
  return 'completed';
}

/** A constraint the database refused with, in words a person can act on. */
function databaseRefusal(error: unknown): Problem | undefined {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23505' && constraint === 'customers_account_number_unique') {
    return {
      column: 'account_number',
      code: 'duplicate',
      message: 'Another customer already has this account number.',
    };
  }
  if (code === '23514' && typeof constraint === 'string') {
    return { column: null, code: 'invalid', message: `This row breaks a rule (${constraint}).` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One importer per kind
// ---------------------------------------------------------------------------

const IMPORTERS: Record<
  ImportKind,
  (tx: TenantTransaction, row: Row, context: ImportContext) => Promise<void>
> = {
  customers: importCustomer,
  sites: importSite,
  work_orders: importWorkOrder,
};

const value = (row: Row, column: string) => {
  const text = row[column];
  return text === undefined || text === '' ? undefined : text;
};

function length(problems: Problem[], row: Row, column: string, max: number) {
  const text = value(row, column);
  if (text !== undefined && text.length > max) {
    problems.push({
      column,
      code: 'too_long',
      message: `${column} is longer than ${String(max)} characters.`,
    });
  }
}

function addressOf(row: Row, problems: Problem[]) {
  const country = value(row, 'country')?.toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/u.test(country)) {
    problems.push({
      column: 'country',
      code: 'invalid',
      message: `"${country}" is not a two-letter country code.`,
    });
  }
  return {
    line1: value(row, 'address_line1') ?? null,
    line2: value(row, 'address_line2') ?? null,
    city: value(row, 'city') ?? null,
    region: value(row, 'region') ?? null,
    postcode: value(row, 'postcode') ?? null,
    countryCode: country ?? null,
  };
}

async function importCustomer(tx: TenantTransaction, row: Row, context: ImportContext) {
  const problems: Problem[] = [];
  const name = value(row, 'name');
  if (name === undefined) {
    problems.push({ column: 'name', code: 'required', message: 'name is empty.' });
  }
  length(problems, row, 'name', 200);
  length(problems, row, 'account_number', 64);
  const status = value(row, 'status')
    ?.toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (status !== undefined && !(CUSTOMER_STATUSES as readonly string[]).includes(status)) {
    problems.push({
      column: 'status',
      code: 'invalid',
      message: `"${status}" is not a status; use active, on_hold or closed.`,
    });
  }
  const email = value(row, 'email');
  if (email !== undefined && !EMAIL.test(email)) {
    problems.push({
      column: 'email',
      code: 'invalid',
      message: `"${email}" is not an email address.`,
    });
  }
  const address = addressOf(row, problems);
  const accountNumber = value(row, 'account_number');
  if (
    accountNumber !== undefined &&
    (await tx.customers.findByAccountNumber(accountNumber)) !== undefined
  ) {
    problems.push({
      column: 'account_number',
      code: 'duplicate',
      message: `A customer with account number ${accountNumber} already exists.`,
    });
  }
  if (problems.length > 0) {
    throw new RowRefused(problems);
  }
  await tx.customers.create(
    {
      name: name!,
      accountNumber: accountNumber ?? null,
      ...(status === undefined ? {} : { status: status as CustomerStatus }),
      email: email ?? null,
      phone: value(row, 'phone') ?? null,
      address,
      tags: (value(row, 'tags') ?? '').split(/[;|]/u),
      notes: value(row, 'notes') ?? null,
    },
    context.actor,
  );
}

async function resolveCustomer(tx: TenantTransaction, row: Row, problems: Problem[]) {
  const account = value(row, 'customer_account_number');
  const name = value(row, 'customer_name');
  if (account !== undefined) {
    const customer = await tx.customers.findByAccountNumber(account);
    if (customer === undefined) {
      problems.push({
        column: 'customer_account_number',
        code: 'not_found',
        message: `No customer has account number ${account}.`,
      });
    }
    return customer;
  }
  if (name === undefined) {
    problems.push({
      column: 'customer_account_number',
      code: 'required',
      message: 'Name the customer, by customer_account_number or customer_name.',
    });
    return undefined;
  }
  const matches = await tx.customers.findByName(name);
  if (matches.length === 0) {
    problems.push({
      column: 'customer_name',
      code: 'not_found',
      message: `No customer is called "${name}".`,
    });
    return undefined;
  }
  if (matches.length > 1) {
    problems.push({
      column: 'customer_name',
      code: 'ambiguous',
      message: `More than one customer is called "${name}"; use customer_account_number.`,
    });
    return undefined;
  }
  return matches[0];
}

async function importSite(tx: TenantTransaction, row: Row, context: ImportContext) {
  const problems: Problem[] = [];
  const customer = await resolveCustomer(tx, row, problems);
  const name = value(row, 'site_name');
  if (name === undefined) {
    problems.push({ column: 'site_name', code: 'required', message: 'site_name is empty.' });
  }
  length(problems, row, 'site_name', 200);
  const address = addressOf(row, problems);
  if (address.line1 === null) {
    problems.push({
      column: 'address_line1',
      code: 'required',
      message: 'address_line1 is empty.',
    });
  }
  for (const [column, max] of [
    ['gate_code', 200],
    ['parking', 2000],
    ['ask_for', 500],
    ['hazards', 4000],
    ['access_notes', 4000],
  ] as const) {
    length(problems, row, column, max);
  }

  const latitudeText = value(row, 'latitude');
  const longitudeText = value(row, 'longitude');
  let location: { latitude: number; longitude: number } | undefined;
  if ((latitudeText === undefined) !== (longitudeText === undefined)) {
    problems.push({
      column: latitudeText === undefined ? 'latitude' : 'longitude',
      code: 'required',
      message: 'Give latitude and longitude together, or neither.',
    });
  } else if (latitudeText !== undefined && longitudeText !== undefined) {
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      problems.push({
        column: 'latitude',
        code: 'invalid',
        message: `"${latitudeText}" is not a latitude.`,
      });
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      problems.push({
        column: 'longitude',
        code: 'invalid',
        message: `"${longitudeText}" is not a longitude.`,
      });
    }
    location = {
      latitude: Math.round(latitude * 1e6) / 1e6,
      longitude: Math.round(longitude * 1e6) / 1e6,
    };
  }

  if (
    customer !== undefined &&
    name !== undefined &&
    (await tx.sites.findByName(customer.id, name)).length > 0
  ) {
    problems.push({
      column: 'site_name',
      code: 'duplicate',
      message: `${customer.name} already has a site called "${name}".`,
    });
  }
  if (problems.length > 0) {
    throw new RowRefused(problems);
  }

  const site = await tx.sites.create(
    customer!.id,
    {
      name: name!,
      address: { ...address, line1: address.line1! },
      access: {
        gateCode: value(row, 'gate_code') ?? null,
        parking: value(row, 'parking') ?? null,
        askFor: value(row, 'ask_for') ?? null,
        hazards: value(row, 'hazards') ?? null,
        notes: value(row, 'access_notes') ?? null,
      },
      ...(location === undefined ? {} : { location }),
    },
    context.actor,
  );
  if (site.geocodeStatus === 'pending') {
    await tx.jobs.enqueue({ queue: GEOCODE_QUEUE, payload: { siteId: site.id } });
  }
}

async function importWorkOrder(tx: TenantTransaction, row: Row, context: ImportContext) {
  const problems: Problem[] = [];
  const customer = await resolveCustomer(tx, row, problems);

  const siteName = value(row, 'site_name');
  let siteId: string | undefined;
  if (siteName === undefined) {
    problems.push({ column: 'site_name', code: 'required', message: 'site_name is empty.' });
  } else if (customer !== undefined) {
    const sites = (await tx.sites.findByName(customer.id, siteName)).filter(
      (site) => site.archivedAt === null,
    );
    if (sites.length === 0) {
      problems.push({
        column: 'site_name',
        code: 'not_found',
        message: `${customer.name} has no site called "${siteName}".`,
      });
    } else {
      siteId = sites[0]!.id;
    }
  }

  const typeText = value(row, 'job_type');
  const jobType =
    typeText === undefined
      ? undefined
      : (context.jobTypes.find(
          (type) => type.code === typeText.toUpperCase().replace(/[^A-Z0-9_-]+/gu, '-'),
        ) ?? context.jobTypes.find((type) => type.name.toLowerCase() === typeText.toLowerCase()));
  if (typeText === undefined) {
    problems.push({ column: 'job_type', code: 'required', message: 'job_type is empty.' });
  } else if (jobType === undefined) {
    problems.push({
      column: 'job_type',
      code: 'not_found',
      message: `No job type has the code or name "${typeText}".`,
    });
  }

  const priority = value(row, 'priority')?.toLowerCase();
  if (priority !== undefined && !(WORK_ORDER_PRIORITIES as readonly string[]).includes(priority)) {
    problems.push({
      column: 'priority',
      code: 'invalid',
      message: `"${priority}" is not a priority; use low, normal, high or urgent.`,
    });
  }
  length(problems, row, 'title', 200);
  length(problems, row, 'description', 10_000);
  length(problems, row, 'instructions', 10_000);

  const due = (column: 'due_from' | 'due_by') => {
    const text = value(row, column);
    if (text === undefined) {
      return undefined;
    }
    const parsed = parseZonedDateTime(text, context.timeZone, { endOfDay: column === 'due_by' });
    if (parsed === undefined) {
      problems.push({
        column,
        code: 'invalid',
        message: `"${text}" is not a date; write 2026-10-01, 2026-10-01 17:00, or ISO 8601 with an offset.`,
      });
    }
    return parsed;
  };
  const dueFrom = due('due_from');
  const dueBy = due('due_by');
  if (dueFrom !== undefined && dueBy !== undefined && dueBy < dueFrom) {
    problems.push({ column: 'due_by', code: 'invalid', message: 'due_by is before due_from.' });
  }

  const emails = (value(row, 'engineers') ?? '')
    .split(/[;|,]/u)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== '');
  const crew: { userId: string; lead: boolean }[] = [];
  const leadEmail = value(row, 'lead')?.toLowerCase();
  for (const email of new Set(emails)) {
    const member = await tx.tenantUsers.findByEmail(email);
    if (member?.status !== 'active') {
      problems.push({
        column: 'engineers',
        code: 'not_found',
        message: `Nobody active in the company has the email ${email}.`,
      });
    } else {
      crew.push({ userId: member.userId, lead: email === leadEmail });
    }
  }
  if (leadEmail !== undefined && !emails.includes(leadEmail)) {
    problems.push({
      column: 'lead',
      code: 'invalid',
      message: 'The lead must be one of the engineers.',
    });
  }

  if (problems.length > 0) {
    throw new RowRefused(problems);
  }

  await tx.workOrders.create(
    {
      customerId: customer!.id,
      siteId: siteId!,
      jobTypeId: jobType!.id,
      ...(value(row, 'title') === undefined ? {} : { title: value(row, 'title')! }),
      description: value(row, 'description') ?? null,
      ...(value(row, 'instructions') === undefined
        ? {}
        : { instructions: value(row, 'instructions')! }),
      ...(priority === undefined ? {} : { priority: priority as WorkOrderPriority }),
      dueFrom: dueFrom ?? null,
      dueBy: dueBy ?? null,
      crew,
    },
    context.actor,
  );
}
