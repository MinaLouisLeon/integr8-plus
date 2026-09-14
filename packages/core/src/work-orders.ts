import { z } from 'zod';
import type { Permission } from './permissions.js';

/**
 * The work order state machine, shared by every client and the API.
 *
 * The database enforces the same table (`work_order_transition_allowed`,
 * migration 0010) and the schema-invariant suite checks the two agree, so a UI
 * that offers a transition the server refuses, or hides one it allows, fails a
 * test rather than a dispatcher.
 */

export const WORK_ORDER_STATES = [
  'scheduled',
  'dispatched',
  'travelling',
  'on_site',
  'in_progress',
  'awaiting_parts',
  'complete',
  'reviewed',
  'cancelled',
] as const;

export const workOrderStateSchema = z.enum(WORK_ORDER_STATES);
export type WorkOrderState = z.infer<typeof workOrderStateSchema>;

export const WORK_ORDER_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const workOrderPrioritySchema = z.enum(WORK_ORDER_PRIORITIES);
export type WorkOrderPriority = z.infer<typeof workOrderPrioritySchema>;

export interface WorkOrderTransition {
  from: WorkOrderState;
  to: WorkOrderState;
  /**
   * Who may make it. `work_order.progress` is the engineer's own work on a job
   * they are assigned to; `work_order.manage` is the office's; `work_order.review`
   * signs a finished job off, or sends it back.
   */
  permission: Extract<
    Permission,
    'work_order.manage' | 'work_order.progress' | 'work_order.review'
  >;
  /** Undoes something a person relied on, so it says why. */
  requiresReason: boolean;
}

const manage = 'work_order.manage' as const;
const progress = 'work_order.progress' as const;
const review = 'work_order.review' as const;

export const WORK_ORDER_TRANSITIONS: readonly WorkOrderTransition[] = Object.freeze([
  { from: 'scheduled', to: 'dispatched', permission: manage, requiresReason: false },
  { from: 'scheduled', to: 'cancelled', permission: manage, requiresReason: true },
  { from: 'dispatched', to: 'scheduled', permission: manage, requiresReason: false },
  { from: 'dispatched', to: 'travelling', permission: progress, requiresReason: false },
  { from: 'dispatched', to: 'on_site', permission: progress, requiresReason: false },
  { from: 'dispatched', to: 'cancelled', permission: manage, requiresReason: true },
  { from: 'travelling', to: 'dispatched', permission: progress, requiresReason: false },
  { from: 'travelling', to: 'on_site', permission: progress, requiresReason: false },
  { from: 'travelling', to: 'cancelled', permission: manage, requiresReason: true },
  { from: 'on_site', to: 'in_progress', permission: progress, requiresReason: false },
  { from: 'on_site', to: 'travelling', permission: progress, requiresReason: false },
  { from: 'in_progress', to: 'awaiting_parts', permission: progress, requiresReason: false },
  { from: 'in_progress', to: 'complete', permission: progress, requiresReason: false },
  { from: 'awaiting_parts', to: 'in_progress', permission: progress, requiresReason: false },
  { from: 'awaiting_parts', to: 'scheduled', permission: manage, requiresReason: false },
  { from: 'awaiting_parts', to: 'dispatched', permission: manage, requiresReason: false },
  { from: 'awaiting_parts', to: 'cancelled', permission: manage, requiresReason: true },
  { from: 'complete', to: 'reviewed', permission: review, requiresReason: false },
  { from: 'complete', to: 'in_progress', permission: review, requiresReason: true },
  { from: 'cancelled', to: 'scheduled', permission: manage, requiresReason: true },
]);

/** The transition from one state to another, or `undefined` if there is none. */
export function findTransition(
  from: WorkOrderState,
  to: WorkOrderState,
): WorkOrderTransition | undefined {
  return WORK_ORDER_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/** Every state a work order may move to next, in the table's order. */
export function nextStates(from: WorkOrderState): WorkOrderTransition[] {
  return WORK_ORDER_TRANSITIONS.filter((transition) => transition.from === from);
}

/** States in which nobody is working the job and nothing about it changes but its state. */
export const CLOSED_WORK_ORDER_STATES: readonly WorkOrderState[] = Object.freeze([
  'complete',
  'reviewed',
  'cancelled',
]);

/** States in which an engineer is out on the job. */
export const ACTIVE_WORK_ORDER_STATES: readonly WorkOrderState[] = Object.freeze([
  'dispatched',
  'travelling',
  'on_site',
  'in_progress',
  'awaiting_parts',
]);

/** `WO-000123`: how a person reads a reference aloud over the phone. */
export function formatWorkOrderReference(reference: number): string {
  return `WO-${String(reference).padStart(6, '0')}`;
}
