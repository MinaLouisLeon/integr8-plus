import { type Employee, withTenant } from '@integr8/db';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, startApi } from '../testing/api-harness.js';
import { resealHrFields } from './reseal.js';
import { hrKeyring, openField, openWithKeyring, sealField } from './sealed-fields.js';

/**
 * Changing the HR key on a deployment that already holds employees' numbers:
 * the old key moves to HR_DATA_KEYS_PREVIOUS, a new one takes its place, and
 * `admin-cli hr-reseal` moves every sealed field under it.
 */

let api: ApiHarness;
const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const ring = hrKeyring(newKey.toString('base64'), [oldKey.toString('base64')]);
const CREATOR = '00000000-0000-4000-8000-00000000c0de';

async function employeeSealedWith(
  key: Buffer,
  numbers: { nationalId: string; bankAccount: string },
): Promise<string> {
  const id = randomUUID();
  const seal = (value: string, field: 'nationalId' | 'bankAccount') => ({
    sealed: sealField(value, key, { tenantId: api.tenantId, employeeId: id, field }),
    last4: value.slice(-4),
  });
  const created = await withTenant(api.tenantId, (tx) =>
    tx.hrEmployees.create(
      {
        id,
        fullName: `Employee ${id.slice(0, 6)}`,
        hireDate: '2025-01-01',
        nationalId: seal(numbers.nationalId, 'nationalId'),
        bankAccount: seal(numbers.bankAccount, 'bankAccount'),
      },
      CREATOR,
    ),
  );
  expect(typeof created === 'object' && 'id' in created).toBe(true);
  return id;
}

async function stored(id: string): Promise<Employee> {
  const employee = await withTenant(api.tenantId, (tx) => tx.hrEmployees.find(id));
  if (employee === undefined) {
    throw new Error('employee missing');
  }
  return employee;
}

beforeAll(async () => {
  api = await startApi({ env: { HR_DATA_KEY: newKey.toString('base64') } });
});

afterAll(async () => {
  await api.close();
});

describe('re-sealing HR numbers under a new key', () => {
  it('moves fields from the old key to the new one, and leaves current ones alone', async () => {
    const before = await employeeSealedWith(oldKey, {
      nationalId: '29001011234567',
      bankAccount: 'EG380019000500000000263180002',
    });
    const already = await employeeSealedWith(newKey, {
      nationalId: '28512310100123',
      bankAccount: 'EG120003000400000000999990001',
    });
    const versionBefore = (await stored(before)).version;

    const report = await resealHrFields({ keyring: ring, tenantIds: [api.tenantId] });
    expect(report).toMatchObject({
      companies: 1,
      resealed: 2,
      current: 2,
      changedMeanwhile: 0,
      unreadable: [],
      byOldKey: { [ring.previous[0]?.id ?? '']: 2 },
    });

    const moved = await stored(before);
    const context = { tenantId: api.tenantId, employeeId: before };
    // Now under the new key alone, with the same number and last four.
    expect(
      openField(moved.nationalId?.sealed ?? '', newKey, { ...context, field: 'nationalId' }),
    ).toBe('29001011234567');
    expect(() =>
      openField(moved.nationalId?.sealed ?? '', oldKey, { ...context, field: 'nationalId' }),
    ).toThrow();
    expect(moved.nationalId?.last4).toBe('4567');
    // The number did not change, so neither does the version.
    expect(moved.version).toBe(versionBefore);
    expect(
      openWithKeyring((await stored(already)).bankAccount?.sealed ?? '', ring, {
        tenantId: api.tenantId,
        employeeId: already,
        field: 'bankAccount',
      }).current,
    ).toBe(true);

    // The company's audit log says it happened, without a number in it.
    const entries = await withTenant(api.tenantId, (tx) => tx.auditLog.list({ limit: 20 }));
    const entry = entries.find((item) => item.action === 'hr.fields_resealed');
    expect(entry?.metadata).toEqual({ fields: 2, key: ring.current.id });
  });

  it('finds nothing to do the second time', async () => {
    const report = await resealHrFields({ keyring: ring, tenantIds: [api.tenantId] });
    expect(report.resealed).toBe(0);
    expect(report.unreadable).toEqual([]);
  });

  it('lists, and keeps, a field no configured key opens', async () => {
    const lost = await employeeSealedWith(randomBytes(32), {
      nationalId: '27001011234567',
      bankAccount: 'EG990000000000000000000000001',
    });
    const before = await stored(lost);

    const report = await resealHrFields({ keyring: ring, tenantIds: [api.tenantId] });
    expect(report.unreadable).toEqual([
      { tenantId: api.tenantId, employeeId: lost, field: 'nationalId' },
      { tenantId: api.tenantId, employeeId: lost, field: 'bankAccount' },
    ]);
    expect((await stored(lost)).nationalId).toEqual(before.nationalId);
  });
});
