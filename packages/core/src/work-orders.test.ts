import { describe, expect, it } from 'vitest';
import { can } from './permissions.js';
import { ROLES } from './roles.js';
import {
  findTransition,
  formatWorkOrderReference,
  nextStates,
  WORK_ORDER_STATES,
  WORK_ORDER_TRANSITIONS,
  type WorkOrderState,
} from './work-orders.js';

describe('the work order state machine', () => {
  it('reaches every state from scheduled', () => {
    const reached = new Set<WorkOrderState>(['scheduled']);
    const queue: WorkOrderState[] = ['scheduled'];
    while (queue.length > 0) {
      for (const transition of nextStates(queue.shift()!)) {
        if (!reached.has(transition.to)) {
          reached.add(transition.to);
          queue.push(transition.to);
        }
      }
    }
    expect([...reached].sort()).toEqual([...WORK_ORDER_STATES].sort());
  });

  it('lets nothing leave reviewed, and nothing skip from scheduled to complete', () => {
    expect(nextStates('reviewed')).toEqual([]);
    expect(findTransition('scheduled', 'complete')).toBeUndefined();
    expect(findTransition('dispatched', 'complete')).toBeUndefined();
  });

  it('names each transition once', () => {
    const keys = WORK_ORDER_TRANSITIONS.map((transition) => `${transition.from}>${transition.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('asks why for every cancellation, reinstatement and reopening, and nothing else', () => {
    const needingReason = WORK_ORDER_TRANSITIONS.filter((transition) => transition.requiresReason)
      .map((transition) => `${transition.from}>${transition.to}`)
      .sort();
    expect(needingReason).toEqual(
      [
        'awaiting_parts>cancelled',
        'cancelled>scheduled',
        'complete>in_progress',
        'dispatched>cancelled',
        'scheduled>cancelled',
        'travelling>cancelled',
      ].sort(),
    );
  });

  it('leaves signing off and reopening to reviewers, and cancelling to the office', () => {
    for (const transition of WORK_ORDER_TRANSITIONS) {
      if (transition.from === 'complete') {
        expect(transition.permission).toBe('work_order.review');
      }
      if (transition.to === 'cancelled' || transition.from === 'cancelled') {
        expect(transition.permission).toBe('work_order.manage');
      }
    }
  });
});

describe('who works jobs', () => {
  it('lets every role but viewer work a job, and only owners and admins sign one off', () => {
    expect(ROLES.filter((role) => can(role, 'work_order.progress'))).toEqual([
      'owner',
      'admin',
      'dispatcher',
      'engineer',
    ]);
    expect(ROLES.filter((role) => can(role, 'work_order.review'))).toEqual(['owner', 'admin']);
    expect(ROLES.filter((role) => can(role, 'work_order.manage'))).toEqual([
      'owner',
      'admin',
      'dispatcher',
    ]);
  });

  it('shows an engineer only their own jobs, and every role the customer details a job needs', () => {
    expect(can('engineer', 'work_order.read_all')).toBe(false);
    expect(ROLES.every((role) => can(role, 'customer.read'))).toBe(true);
  });

  it('keeps job type configuration and imports to owners and admins', () => {
    for (const permission of ['job_type.manage', 'import.run'] as const) {
      expect(ROLES.filter((role) => can(role, permission))).toEqual(['owner', 'admin']);
    }
  });
});

describe('references', () => {
  it('reads as WO and six digits, growing past a million without truncating', () => {
    expect(formatWorkOrderReference(123)).toBe('WO-000123');
    expect(formatWorkOrderReference(1_234_567)).toBe('WO-1234567');
  });
});
