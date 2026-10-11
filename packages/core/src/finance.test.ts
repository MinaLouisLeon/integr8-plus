import { describe, expect, it } from 'vitest';
import {
  addDays,
  hoursOfMs,
  invoiceStatus,
  multiplyDecimals,
  parseFinanceReference,
} from './finance.js';

describe('finance vocabulary', () => {
  it('derives an issued invoice’s status from its balance and payments', () => {
    expect(invoiceStatus('draft', { balance: '10', allocated: '0' })).toBe('draft');
    expect(invoiceStatus('void', { balance: '10', allocated: '0' })).toBe('void');
    expect(invoiceStatus('issued', { balance: '10', allocated: '0' })).toBe('issued');
    expect(invoiceStatus('issued', { balance: '4', allocated: '6' })).toBe('partially_paid');
    expect(invoiceStatus('issued', { balance: '0', allocated: '10' })).toBe('paid');
    expect(invoiceStatus('issued', { balance: '0', allocated: '0' })).toBe('credited');
  });

  it('reads references however they are typed', () => {
    expect(parseFinanceReference('INV-000123')).toBe(123);
    expect(parseFinanceReference('cn-7')).toBe(7);
    expect(parseFinanceReference('RC000042')).toBe(42);
    expect(parseFinanceReference(' 15 ')).toBe(15);
    expect(parseFinanceReference('INV-0')).toBeUndefined();
    expect(parseFinanceReference('Riverside')).toBeUndefined();
  });

  it('turns time into hours without a float’s tail, and counts calendar days', () => {
    expect(hoursOfMs(5_400_000)).toBe('1.5');
    expect(hoursOfMs(3_600_000)).toBe('1');
    expect(hoursOfMs(20 * 60_000)).toBe('0.33');
    expect(hoursOfMs(0)).toBe('0');
    expect(hoursOfMs(-5)).toBe('0');
    expect(addDays('2026-10-11', 30)).toBe('2026-11-10');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('multiplies decimal text exactly, rounding half up to four places', () => {
    expect(multiplyDecimals('1.5', '120.25')).toBe('180.375');
    expect(multiplyDecimals('0.33', '150')).toBe('49.5');
    expect(multiplyDecimals('2', '0')).toBe('0');
    expect(multiplyDecimals('0.0001', '0.5')).toBe('0.0001');
    expect(multiplyDecimals('0.0001', '0.4')).toBe('0');
    expect(multiplyDecimals('12345678.9', '1000')).toBe('12345678900');
  });
});
