import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The unposted list over HTTP (CRM/ERP plan, phase A1; ADR-0009): invoices
 * recorded before the ledger was set up wait for review; issued invoices post
 * at once; with automatic posting switched off they wait to be posted one by
 * one — as proposed, edited or redated — or together, or set aside with a
 * reason; a credit note follows its invoice; a document in another currency
 * posts at a typed rate.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let dispatcher: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;

/** The ledger starts this month, so today's documents are in it. */
const now = new Date();
const START = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  .toISOString()
  .slice(0, 10);

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

interface Posting {
  id: string;
  source: { kind: string; id: string };
  label: string | null;
  documentDate: string;
  currency: string;
  amount: string;
  status: string;
  reason: string | null;
  journal: { id: string; reference: string | null } | null;
  skipReason: string | null;
}
interface PostingDetail extends Posting {
  lines: {
    account: { code: string };
    debit: string;
    credit: string;
    customer: { id: string } | null;
  }[];
  totals: { debit: string; credit: string; balanced: boolean };
  companyCurrency: string;
  invoice: { id: string; label: string | null; status: string } | null;
  can: { post: boolean; skip: boolean };
}
interface Journal {
  id: string;
  reference: string | null;
  status: string;
  kind: string;
  entryDate: string;
  memo: string | null;
  source: { kind: string; id: string } | null;
  foreign: { currency: string; rate: string; source: string } | null;
  lines: {
    account: { code: string };
    debit: string;
    credit: string;
    foreignAmount: string | null;
  }[];
}
interface Page {
  items: Posting[];
  nextCursor: string | null;
  counts: { total: number; byReason: Record<string, number> };
}

const lines = (detail: { lines: { account: { code: string }; debit: string; credit: string }[] }) =>
  detail.lines.map((line) => [line.account.code, line.debit, line.credit]);

let accounts: Map<string, string>;
const account = (accountCode: string) => accounts.get(accountCode)!;

/** An invoice for 100 plus 14 % tax, issued today. */
async function issueInvoice(payload: Record<string, unknown> = {}) {
  const drafted = await call(
    owner,
    'POST',
    '/v1/finance/invoices',
    {
      customerId,
      lines: [{ description: 'Annual service', quantity: '1', unitPrice: '100', taxRateBp: 1400 }],
      ...payload,
    },
    randomUUID(),
  );
  expect(drafted.statusCode, drafted.body).toBe(201);
  const draft = json<{ invoice: { id: string; version: number } }>(drafted);
  const issued = await call(owner, 'POST', `/v1/finance/invoices/${draft.invoice.id}/issue`, {
    expectedVersion: draft.invoice.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);
  return json<{ invoice: { id: string; version: number }; lines: { id: string }[] }>(issued);
}

async function postingFor(sourceId: string, status = 'pending'): Promise<Posting> {
  const page = json<Page>(
    await call(viewer, 'GET', `/v1/ledger/postings?status=${status}&limit=200`),
  );
  const found = page.items.find((item) => item.source.id === sourceId);
  expect(found, `${sourceId} ${status}`).toBeDefined();
  return found!;
}

async function saveSettings(changes: Record<string, unknown>) {
  const overview = json<{ settings: { version: number } }>(await call(admin, 'GET', '/v1/ledger'));
  const saved = await call(admin, 'PUT', '/v1/ledger/settings', {
    expectedVersion: overview.settings.version,
    ...changes,
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('lp-staff');
  owner = await api.member('owner', 'lp-owner');
  admin = await api.member('admin', 'lp-admin');
  dispatcher = await api.member('dispatcher', 'lp-dispatcher');
  viewer = await api.member('viewer', 'lp-viewer');
  await setFlag('finance', true);
  await setFlag('ledger', true);
  const customer = await call(owner, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  customerId = json<{ id: string }>(customer).id;
});

afterAll(async () => {
  await api.close();
});

describe('setting up', () => {
  it('puts what was recorded since the start in the list for review', async () => {
    const before = await issueInvoice();
    const setUp = await call(admin, 'POST', '/v1/ledger/setup', { startDate: START }, randomUUID());
    expect(setUp.statusCode, setUp.body).toBe(201);
    expect(json<{ unposted: unknown }>(setUp).unposted).toEqual({
      total: 1,
      byReason: { before_set_up: 1 },
    });
    accounts = new Map(
      json<{ items: { id: string; code: string }[] }>(
        await call(viewer, 'GET', '/v1/ledger/accounts'),
      ).items.map((item) => [item.code, item.id]),
    );

    const waiting = await postingFor(before.invoice.id);
    expect(waiting).toMatchObject({
      source: { kind: 'invoice' },
      reason: 'before_set_up',
      amount: '114',
      currency: 'EGP',
      journal: null,
    });
    expect(waiting.label).toMatch(/^INV-\d{6}$/u);
    const detail = json<PostingDetail>(
      await call(viewer, 'GET', `/v1/ledger/postings/${waiting.id}`),
    );
    expect(lines(detail)).toEqual([
      ['1200', '114', '0'],
      ['4100', '0', '100'],
      ['2200', '0', '14'],
    ]);
    expect(detail.lines[0]!.customer).toMatchObject({ id: customerId });
    expect(detail).toMatchObject({ companyCurrency: 'EGP', can: { post: false, skip: false } });
    expect((await call(dispatcher, 'GET', '/v1/ledger/postings')).statusCode).toBe(403);
    expect(
      (await call(viewer, 'POST', `/v1/ledger/postings/${waiting.id}/post`, {}, randomUUID()))
        .statusCode,
    ).toBe(403);

    const posted = await call(
      admin,
      'POST',
      `/v1/ledger/postings/${waiting.id}/post`,
      {},
      randomUUID(),
    );
    expect(posted.statusCode, posted.body).toBe(200);
    const journal = json<Journal>(posted);
    expect(journal).toMatchObject({
      status: 'posted',
      kind: 'automatic',
      source: { kind: 'invoice', id: before.invoice.id },
      memo: waiting.label,
    });
    expect(journal.reference).toMatch(/^JV-\d{6}$/u);
    expect(
      code(await call(admin, 'POST', `/v1/ledger/postings/${waiting.id}/post`, {}, randomUUID())),
    ).toBe('not_pending');
    expect(await postingFor(before.invoice.id, 'posted')).toMatchObject({
      journal: { id: journal.id, reference: journal.reference },
    });
  });
});

describe('automatic posting', () => {
  it('posts an issued invoice at once', async () => {
    const issued = await issueInvoice();
    const posting = await postingFor(issued.invoice.id, 'posted');
    const journal = json<Journal>(
      await call(viewer, 'GET', `/v1/ledger/journals/${posting.journal!.id}`),
    );
    expect(journal).toMatchObject({ kind: 'automatic', status: 'posted' });
    expect(lines(journal)).toEqual([
      ['1200', '114', '0'],
      ['4100', '0', '100'],
      ['2200', '0', '14'],
    ]);
  });

  it('when switched off, waits to be posted by hand, edited, together, or set aside', async () => {
    await saveSettings({ autoPostSales: false });
    const first = await issueInvoice();
    const waiting = await postingFor(first.invoice.id);
    expect(waiting.reason).toBe('auto_off');

    // A credit note follows its invoice.
    const credited = await call(
      owner,
      'POST',
      `/v1/finance/invoices/${first.invoice.id}/credit-notes`,
      {
        reason: 'Discount agreed',
        lines: [
          {
            invoiceLineId: first.lines[0]!.id,
            description: 'Discount',
            quantity: '1',
            unitPrice: '50',
          },
        ],
      },
      randomUUID(),
    );
    expect(credited.statusCode, credited.body).toBe(201);
    const note = json<{ creditNote: { id: string; version: number } }>(credited);
    const noteIssued = await call(
      owner,
      'POST',
      `/v1/finance/credit-notes/${note.creditNote.id}/issue`,
      {
        expectedVersion: note.creditNote.version,
      },
    );
    expect(noteIssued.statusCode, noteIssued.body).toBe(200);
    const notePosting = await postingFor(note.creditNote.id);
    const noteDetail = json<PostingDetail>(
      await call(admin, 'GET', `/v1/ledger/postings/${notePosting.id}`),
    );
    expect(noteDetail.invoice).toMatchObject({ id: waiting.id, status: 'pending' });
    expect(
      code(
        await call(admin, 'POST', `/v1/ledger/postings/${notePosting.id}/post`, {}, randomUUID()),
      ),
    ).toBe('waits_for_invoice');

    // Posted by hand, to other accounts: the lines must balance.
    const unbalanced = await call(
      admin,
      'POST',
      `/v1/ledger/postings/${waiting.id}/post`,
      {
        lines: [
          { accountId: account('1200'), debit: '114', customerId },
          { accountId: account('4200'), credit: '100' },
        ],
      },
      randomUUID(),
    );
    expect(code(unbalanced)).toBe('unbalanced');
    const edited = await call(
      admin,
      'POST',
      `/v1/ledger/postings/${waiting.id}/post`,
      {
        lines: [
          { accountId: account('1200'), debit: '114', customerId },
          { accountId: account('4100'), credit: '60' },
          { accountId: account('4200'), credit: '40' },
          { accountId: account('2200'), credit: '14' },
        ],
      },
      randomUUID(),
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect(lines(json<Journal>(edited))).toEqual([
      ['1200', '114', '0'],
      ['4100', '0', '60'],
      ['4200', '0', '40'],
      ['2200', '0', '14'],
    ]);
    // The switch is off, so the credit note now waits for that, not its invoice.
    expect((await postingFor(note.creditNote.id)).reason).toBe('auto_off');

    // Together.
    const second = await issueInvoice();
    const all = await call(admin, 'POST', '/v1/ledger/postings/post-all', {
      kind: ['credit_note'],
    });
    expect(all.statusCode, all.body).toBe(200);
    expect(json<{ posted: number; counts: { total: number } }>(all)).toMatchObject({
      posted: 1,
      counts: { total: 1 },
    });
    const creditJournal = (await postingFor(note.creditNote.id, 'posted')).journal!;
    const creditDetail = json<Journal & { sourceInvoiceId: string | null }>(
      await call(viewer, 'GET', `/v1/ledger/journals/${creditJournal.id}`),
    );
    // The credit note's journal names the invoice it credits.
    expect(creditDetail.sourceInvoiceId).toBe(first.invoice.id);
    expect(lines(creditDetail)).toEqual([
      ['4100', '50', '0'],
      ['1200', '0', '50'],
    ]);

    // Set aside, with a reason; voiding it later sets the void aside too.
    const secondPosting = await postingFor(second.invoice.id);
    expect(
      (
        await call(admin, 'POST', `/v1/ledger/postings/${secondPosting.id}/skip`, {
          reason: '',
        })
      ).statusCode,
    ).toBe(422);
    const skipped = await call(admin, 'POST', `/v1/ledger/postings/${secondPosting.id}/skip`, {
      reason: 'Entered in the old system',
    });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(json<PostingDetail>(skipped)).toMatchObject({
      status: 'skipped',
      skipReason: 'Entered in the old system',
      can: { post: false, skip: false },
    });
    const voided = await call(owner, 'POST', `/v1/finance/invoices/${second.invoice.id}/void`, {
      expectedVersion: second.invoice.version,
      reason: 'Raised in error',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const page = json<Page>(await call(viewer, 'GET', '/v1/ledger/postings?status=skipped'));
    expect(page.items.find((item) => item.source.kind === 'invoice_void')).toMatchObject({
      source: { id: second.invoice.id },
      skipReason: 'Its invoice was set aside',
    });
    expect(
      json<{ unposted: { total: number } }>(await call(viewer, 'GET', '/v1/ledger')).unposted,
    ).toEqual({ total: 0, byReason: {} });
    await saveSettings({ autoPostSales: true });
  });

  it('posts a document in another currency at a typed rate, and says where it came from', async () => {
    const dollars = await issueInvoice({ currencyCode: 'USD' });
    const waiting = await postingFor(dollars.invoice.id);
    expect(waiting).toMatchObject({ reason: 'foreign_currency', currency: 'USD', amount: '114' });
    const noRate = await call(
      admin,
      'POST',
      `/v1/ledger/postings/${waiting.id}/post`,
      {},
      randomUUID(),
    );
    expect(noRate.statusCode).toBe(422);
    expect(code(noRate)).toBe('rate_required');
    // Post-all leaves it for one-by-one review.
    expect(
      json<{ posted: number }>(await call(admin, 'POST', '/v1/ledger/postings/post-all', {})),
    ).toMatchObject({ posted: 0 });
    const posted = await call(
      admin,
      'POST',
      `/v1/ledger/postings/${waiting.id}/post`,
      { rate: '48.75', rateSource: 'Central Bank of Egypt, morning rate' },
      randomUUID(),
    );
    expect(posted.statusCode, posted.body).toBe(200);
    const journal = json<Journal>(posted);
    expect(journal.foreign).toEqual({
      currency: 'USD',
      rate: '48.75',
      source: 'Central Bank of Egypt, morning rate',
    });
    expect(
      journal.lines.map((line) => [line.account.code, line.debit, line.credit, line.foreignAmount]),
    ).toEqual([
      ['1200', '5557.5', '0', '114'],
      ['4100', '0', '4875', '100'],
      ['2200', '0', '682.5', '14'],
    ]);
  });
});
