import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  activityStartsDone,
  basisPointsSchema,
  currencyCodeSchema,
  DEFAULT_PIPELINE_STAGES,
  decimalAmountSchema,
  hasFeature,
  isLeadOpen,
  leadConvertible,
  LEAD_STATUSES,
  leadTransitionAllowed,
  OPEN_LEAD_STATUSES,
  OPPORTUNITY_EVENT_KINDS,
  opportunityEventKind,
  opportunityMoveAllowed,
  STAGE_OUTCOMES,
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

describe('the pipeline', () => {
  it('starts every company with open stages, one win and one loss', () => {
    const outcomes = DEFAULT_PIPELINE_STAGES.map((stage) => stage.outcome);
    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'lost')).toHaveLength(1);
    expect(new Set(DEFAULT_PIPELINE_STAGES.map((stage) => stage.key)).size).toBe(
      DEFAULT_PIPELINE_STAGES.length,
    );
    for (const stage of DEFAULT_PIPELINE_STAGES) {
      expect(basisPointsSchema.safeParse(stage.probabilityBp).success).toBe(true);
      expect(STAGE_OUTCOMES).toContain(stage.outcome);
    }
  });

  it('moves within one pipeline, to a live stage that is not the current one', () => {
    const here = { id: 'a', pipelineId: 'p' };
    expect(opportunityMoveAllowed(here, { id: 'b', pipelineId: 'p', archivedAt: null })).toBe(true);
    expect(opportunityMoveAllowed(here, { id: 'a', pipelineId: 'p', archivedAt: null })).toBe(
      false,
    );
    expect(opportunityMoveAllowed(here, { id: 'b', pipelineId: 'q', archivedAt: null })).toBe(
      false,
    );
    expect(opportunityMoveAllowed(here, { id: 'b', pipelineId: 'p', archivedAt: new Date() })).toBe(
      false,
    );
  });

  it('names each move in the history', () => {
    expect(opportunityEventKind('open', 'open')).toBe('stage_changed');
    expect(opportunityEventKind('open', 'won')).toBe('won');
    expect(opportunityEventKind('open', 'lost')).toBe('lost');
    expect(opportunityEventKind('lost', 'open')).toBe('reopened');
    expect(opportunityEventKind('won', 'lost')).toBe('lost');
    expect(OPPORTUNITY_EVENT_KINDS).toContain(opportunityEventKind('won', 'open'));
  });

  it('keeps probabilities whole basis points', () => {
    expect(basisPointsSchema.safeParse(2500).success).toBe(true);
    expect(basisPointsSchema.safeParse(25.5).success).toBe(false);
    expect(basisPointsSchema.safeParse(10_001).success).toBe(false);
  });
});

describe('activities', () => {
  it('writes notes as done and starts everything else open', () => {
    expect(ACTIVITY_KINDS.filter(activityStartsDone)).toEqual(['note']);
    expect(ACTIVITY_STATUSES).toEqual(['open', 'done', 'cancelled']);
  });
});
