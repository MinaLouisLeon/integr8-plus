import { describe, expect, it } from 'vitest';
import {
  currencyCodeSchema,
  decimalAmountSchema,
  hasFeature,
  isLeadOpen,
  leadConvertible,
  LEAD_STATUSES,
  leadTransitionAllowed,
  OPEN_LEAD_STATUSES,
} from './crm.js';
import { can } from './permissions.js';
import { ROLES } from './roles.js';

describe('who may use the CRM (product decision, 2026-10-11)', () => {
  it('lets owners, admins and dispatchers do everything in it', () => {
    for (const permission of [
      'crm.read',
      'crm.lead.manage',
      'crm.lead.convert',
      'crm.opportunity.manage',
      'crm.activity.manage',
    ] as const) {
      expect(
        ROLES.filter((role) => can(role, permission)),
        permission,
      ).toEqual(
        permission === 'crm.read'
          ? ['owner', 'admin', 'dispatcher', 'viewer']
          : ['owner', 'admin', 'dispatcher'],
      );
    }
  });

  it('gives an engineer no CRM access at all, though they read customers for their jobs', () => {
    expect(can('engineer', 'customer.read')).toBe(true);
    expect(can('engineer', 'crm.read')).toBe(false);
  });
});

describe('modules', () => {
  it('treats a module as on only when the company has it switched on', () => {
    expect(hasFeature({ crm: true }, 'crm')).toBe(true);
    expect(hasFeature({ crm: false }, 'crm')).toBe(false);
    expect(hasFeature({}, 'crm')).toBe(false);
    expect(hasFeature(undefined, 'crm')).toBe(false);
  });
});

describe('lead statuses', () => {
  it('moves freely among the open statuses', () => {
    for (const from of OPEN_LEAD_STATUSES) {
      for (const to of OPEN_LEAD_STATUSES) {
        expect(leadTransitionAllowed(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('never reaches converted by an edit, and never leaves it', () => {
    for (const status of OPEN_LEAD_STATUSES) {
      expect(leadTransitionAllowed(status, 'converted')).toBe(false);
      expect(leadTransitionAllowed('converted', status)).toBe(false);
    }
    expect(leadTransitionAllowed('converted', 'converted')).toBe(true);
  });

  it('counts a lead as open until it is converted or ruled out', () => {
    expect(LEAD_STATUSES.filter(isLeadOpen)).toEqual(['new', 'contacted', 'qualified']);
    expect(LEAD_STATUSES.filter((status) => leadConvertible({ status, archivedAt: null }))).toEqual(
      ['new', 'contacted', 'qualified'],
    );
    expect(leadConvertible({ status: 'qualified', archivedAt: new Date() })).toBe(false);
  });
});

describe('money and currency', () => {
  it('accepts decimal strings and refuses anything a float would mangle', () => {
    expect(decimalAmountSchema.safeParse('1250.5').success).toBe(true);
    expect(decimalAmountSchema.safeParse('0').success).toBe(true);
    expect(decimalAmountSchema.safeParse('9999999999999999.9999').success).toBe(true);
    expect(decimalAmountSchema.safeParse('1.23456').success).toBe(false);
    expect(decimalAmountSchema.safeParse('-5').success).toBe(false);
    expect(decimalAmountSchema.safeParse('1e6').success).toBe(false);
    expect(decimalAmountSchema.safeParse('').success).toBe(false);
  });

  it('accepts three-letter upper-case currency codes only', () => {
    expect(currencyCodeSchema.safeParse('EGP').success).toBe(true);
    expect(currencyCodeSchema.safeParse('egp').success).toBe(false);
    expect(currencyCodeSchema.safeParse('EURO').success).toBe(false);
  });
});
