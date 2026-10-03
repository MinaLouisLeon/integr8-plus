import { describe, expect, it } from 'vitest';
import { toPlatformUserId, toTenantId, toUserId } from './ids.js';

const VALID_UUID = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';

describe('branded identifiers', () => {
  it('accepts a valid UUID', () => {
    expect(toTenantId(VALID_UUID)).toBe(VALID_UUID);
    expect(toUserId(VALID_UUID)).toBe(VALID_UUID);
    expect(toPlatformUserId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('rejects a value that is not a UUID', () => {
    expect(() => toTenantId('acme-ltd')).toThrow();
    expect(() => toUserId('')).toThrow();
  });
});
