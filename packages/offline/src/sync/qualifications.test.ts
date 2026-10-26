import { describe, expect, it } from 'vitest';
import type { PullPage } from '../api-types.js';
import { type MyQualification, myQualifications, sortQualifications } from '../qualifications.js';
import { me } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import { pullChanges } from './pull.js';
import type { SyncApi } from './transport.js';

/**
 * The engineer's own skills and certificates on the phone (P26): kept from the
 * first page of each pull, shown with no signal, and kept when a pull says
 * nothing about them.
 */

const NOW = new Date('2026-10-27T09:00:00.000Z');
const ENGINEER = '00000000-0000-4000-8000-00000000e401';

const record = (
  id: string,
  name: string,
  state: MyQualification['state'],
  expiresOn: string | null,
): MyQualification => ({
  id,
  person: { id: ENGINEER, name: 'Ed Engineer' },
  qualificationType: { id: `${id}-type`, name, kind: expiresOn === null ? 'skill' : 'certificate' },
  reference: null,
  issuedOn: null,
  expiresOn,
  notes: null,
  state,
  version: 1,
  attachments: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  removedAt: null,
  removedBy: null,
});

const GAS = record('00000000-0000-4000-8000-00000000a401', 'Gas safe', 'valid', '2028-01-01');
const EICR = record(
  '00000000-0000-4000-8000-00000000a402',
  'Inspection and testing',
  'expiring',
  '2026-11-10',
);
const PASMA = record('00000000-0000-4000-8000-00000000a403', 'PASMA', 'expired', '2026-09-01');

const page = (cursor: string, myQualifications?: PullPage['myQualifications']): PullPage => {
  const body: PullPage = {
    reset: false,
    cursor,
    page: null,
    serverTime: NOW.toISOString(),
    workOrders: [],
    removedWorkOrderIds: [],
    customers: [],
    forms: [],
    submissions: [],
    shifts: [],
    vanStock: null,
    assetSiteIds: [],
    assets: [],
    expenseCategories: null,
    myQualifications: myQualifications ?? null,
  };
  if (myQualifications === undefined) {
    // A server from before P26 sends no field at all.
    delete (body as Partial<PullPage>).myQualifications;
  }
  return body;
};

const policy = { closedJobDays: 30, downloadedFileBytes: 500 * 1024 * 1024 };
const clock = { now: () => NOW };

const serving = (...pages: PullPage[]) =>
  ({
    me: () => Promise.resolve(me()),
    pull: () => Promise.resolve(pages.shift()!),
    mediaLink: (fileId: string) => Promise.resolve({ url: `https://files/${fileId}` }),
  }) as unknown as SyncApi;

describe('my qualifications on the phone', () => {
  it('keeps what the first page says, most urgent first', async () => {
    const { db } = await openTestDatabase();
    expect(await db.read(myQualifications)).toEqual({
      items: [],
      today: null,
      warningDays: null,
      receivedAt: null,
    });

    await pullChanges(
      db,
      serving(
        page('v1.1', {
          items: [GAS, EICR, PASMA],
          settings: { warningDays: 30 },
          today: '2026-10-27',
        }),
      ),
      clock,
      policy,
    );
    const held = await db.read(myQualifications);
    expect(held.items.map((item) => item.qualificationType.name)).toEqual([
      'PASMA',
      'Inspection and testing',
      'Gas safe',
    ]);
    expect(held).toMatchObject({ today: '2026-10-27', warningDays: 30 });
    expect(held.receivedAt).not.toBeNull();
  });

  it('keeps the last answer when a pull says nothing about them', async () => {
    const { db } = await openTestDatabase();
    await pullChanges(
      db,
      serving(page('v1.1', { items: [GAS], settings: { warningDays: 30 }, today: '2026-10-27' })),
      clock,
      policy,
    );
    await pullChanges(db, serving(page('v1.2')), clock, policy);
    expect((await db.read(myQualifications)).items.map((item) => item.id)).toEqual([GAS.id]);
  });

  it('sorts skills without an expiry after certificates', () => {
    const skill = record(
      '00000000-0000-4000-8000-00000000a404',
      'Fault finding',
      'no_expiry',
      null,
    );
    expect(sortQualifications([skill, GAS]).map((item) => item.id)).toEqual([GAS.id, skill.id]);
  });
});
