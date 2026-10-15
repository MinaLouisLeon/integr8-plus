import { ApiRequestError } from '@integr8/api-client';
import { describe, expect, it } from 'vitest';
import {
  formatMicrousdPrecise,
  microsToUsdInput,
  parseSharePercent,
  parseUsdToMicros,
  unassignedFromRefusal,
} from './ai-shares';

describe('parseSharePercent', () => {
  it('reads empty as no share and a whole number from 1 to 100 as itself', () => {
    expect(parseSharePercent('')).toBeNull();
    expect(parseSharePercent('  ')).toBeNull();
    expect(parseSharePercent('1')).toBe(1);
    expect(parseSharePercent(' 30 ')).toBe(30);
    expect(parseSharePercent('100')).toBe(100);
  });

  it('refuses what the API would refuse', () => {
    for (const value of ['0', '101', '12.5', '-3', 'ten', '1e2']) {
      expect(parseSharePercent(value)).toBe('invalid');
    }
  });
});

describe('unassignedFromRefusal', () => {
  it('reads what is still unassigned from a refusal for passing 100%', () => {
    const refusal = new ApiRequestError(422, 'ai_shares_over_total', 'Too much.', 'req-1', [
      {
        field: 'body.sharePercent',
        code: 'ai_shares_over_total',
        message: 'Too much.',
        params: { availablePercent: '15' },
      },
    ]);
    expect(unassignedFromRefusal(refusal)).toBe(15);
  });

  it('says nothing for any other failure', () => {
    expect(unassignedFromRefusal(new Error('boom'))).toBeNull();
    expect(
      unassignedFromRefusal(new ApiRequestError(409, 'ai_member_limits_changed', 'x', 'req-2')),
    ).toBeNull();
  });
});

describe('dollars and micros', () => {
  it('converts typed dollars to integer micros on the digits', () => {
    expect(parseUsdToMicros('')).toBeNull();
    expect(parseUsdToMicros('12')).toBe(12_000_000);
    expect(parseUsdToMicros('0.07')).toBe(70_000);
    expect(parseUsdToMicros('4.5')).toBe(4_500_000);
    expect(parseUsdToMicros('0.000001')).toBe(1);
  });

  it('refuses a zero, a negative or more than six decimals', () => {
    for (const value of ['0', '0.00', '-1', '1.0000001', 'five', '1,5']) {
      expect(parseUsdToMicros(value)).toBe('invalid');
    }
  });

  it('shows micros as the dollars that would be typed', () => {
    expect(microsToUsdInput(12_000_000)).toBe('12');
    expect(microsToUsdInput(12_500_000)).toBe('12.5');
    expect(microsToUsdInput(70_000)).toBe('0.07');
    expect(microsToUsdInput(1)).toBe('0.000001');
  });

  it('formats a small spend with enough decimals to see it', () => {
    expect(formatMicrousdPrecise(12_345, 'en')).toBe('$0.0123');
    expect(formatMicrousdPrecise(5_000_000, 'en')).toBe('$5.00');
  });
});
