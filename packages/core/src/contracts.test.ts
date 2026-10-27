import { describe, expect, it } from 'vitest';
import {
  type ContractTerms,
  contractLastDay,
  contractStanding,
  contractYear,
  coverageFor,
  formatContractReference,
  renewalNoticeDay,
  renewalTerm,
} from './contracts.js';

const contract: ContractTerms = {
  id: 'c1',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  cancelledOn: null,
  allSites: true,
  siteIds: [],
  allAssets: true,
  assetIds: [],
  allJobTypes: true,
  jobTypeIds: [],
  includedCallouts: null,
  calloutsUsed: 0,
};

const job = { day: '2026-06-01', siteId: 's1', assetIds: ['a1'], jobTypeId: 't1' };

describe('contract terms', () => {
  it('numbers contracts', () => {
    expect(formatContractReference(12)).toBe('CT-000012');
  });

  it('ends coverage the day before it was cancelled', () => {
    expect(contractLastDay(contract)).toBe('2026-12-31');
    expect(contractLastDay({ ...contract, cancelledOn: '2026-07-01' })).toBe('2026-06-30');
  });

  it('reads its standing, ending within the notice period', () => {
    const terms = { ...contract, renewalNoticeDays: 60 };
    expect(contractStanding(terms, '2025-12-31')).toBe('upcoming');
    expect(contractStanding(terms, '2026-06-01')).toBe('active');
    expect(contractStanding(terms, '2026-11-15')).toBe('ending');
    expect(contractStanding(terms, '2027-01-01')).toBe('ended');
    expect(contractStanding({ ...terms, cancelledOn: '2026-05-01' }, '2026-06-01')).toBe(
      'cancelled',
    );
    expect(renewalNoticeDay(terms)).toBe('2026-11-01');
  });

  it('counts contract years from the start date', () => {
    expect(contractYear('2026-03-15', '2026-03-15')).toEqual({
      from: '2026-03-15',
      to: '2027-03-14',
    });
    expect(contractYear('2026-03-15', '2028-03-14')).toEqual({
      from: '2027-03-15',
      to: '2028-03-14',
    });
    expect(contractYear('2026-03-15', '2028-03-15')).toEqual({
      from: '2028-03-15',
      to: '2029-03-14',
    });
  });

  it('renews whole months as whole months, and other terms for as many days', () => {
    expect(renewalTerm(contract)).toEqual({ startsOn: '2027-01-01', endsOn: '2027-12-31' });
    expect(renewalTerm({ startsOn: '2026-02-01', endsOn: '2026-04-30' })).toEqual({
      startsOn: '2026-05-01',
      endsOn: '2026-07-31',
    });
    expect(renewalTerm({ startsOn: '2026-01-10', endsOn: '2026-01-19' })).toEqual({
      startsOn: '2026-01-20',
      endsOn: '2026-01-29',
    });
  });
});

describe('coverage', () => {
  it('shows nothing for a customer who never had a contract', () => {
    expect(coverageFor({ ...job, contracts: [] })).toBeUndefined();
  });

  it('covers a job a running contract covers', () => {
    expect(coverageFor({ ...job, contracts: [contract] })).toEqual({
      status: 'covered',
      reason: 'contract',
      contractId: 'c1',
    });
  });

  it('says why a job is chargeable', () => {
    const cases: [Partial<ContractTerms>, string][] = [
      [{ allSites: false, siteIds: ['s2'] }, 'site_not_covered'],
      [{ allAssets: false, assetIds: ['a2'] }, 'asset_not_covered'],
      [{ allJobTypes: false, jobTypeIds: ['t2'] }, 'job_type_not_covered'],
      [{ includedCallouts: 2, calloutsUsed: 2 }, 'callouts_used'],
    ];
    for (const [change, reason] of cases) {
      expect(coverageFor({ ...job, contracts: [{ ...contract, ...change }] })).toEqual({
        status: 'chargeable',
        reason,
        contractId: 'c1',
      });
    }
  });

  it('tells an ended contract from none yet', () => {
    expect(coverageFor({ ...job, day: '2027-02-01', contracts: [contract] })).toEqual({
      status: 'chargeable',
      reason: 'contract_ended',
      contractId: null,
    });
    expect(coverageFor({ ...job, day: '2025-06-01', contracts: [contract] })?.reason).toBe(
      'no_contract',
    );
    expect(
      coverageFor({
        ...job,
        day: '2026-08-01',
        contracts: [{ ...contract, cancelledOn: '2026-07-01' }],
      })?.reason,
    ).toBe('contract_ended');
  });

  it('uses another running contract when the first does not cover the job', () => {
    const second = { ...contract, id: 'c2', startsOn: '2026-02-01' };
    expect(
      coverageFor({ ...job, contracts: [{ ...contract, allSites: false, siteIds: [] }, second] }),
    ).toEqual({ status: 'covered', reason: 'contract', contractId: 'c2' });
  });

  it('covers a planned job under its plan’s contract, without using call-outs', () => {
    const limited = { ...contract, includedCallouts: 0, allJobTypes: false, jobTypeIds: [] };
    expect(coverageFor({ ...job, fromPlan: { contractId: 'c1' }, contracts: [limited] })).toEqual({
      status: 'covered',
      reason: 'maintenance_plan',
      contractId: 'c1',
    });
    expect(
      coverageFor({
        ...job,
        fromPlan: { contractId: null },
        contracts: [{ ...contract, includedCallouts: 0 }],
      }),
    ).toEqual({ status: 'covered', reason: 'maintenance_plan', contractId: 'c1' });
  });
});
