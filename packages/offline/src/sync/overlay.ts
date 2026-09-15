import type { AccessValues, WorkOrderDetail } from '../api-types.js';

/**
 * A change the engineer made, shown on the job before the server has it.
 *
 * The same functions run when the change is made and again after every pull, on
 * top of what the server sent: a download never makes an engineer's own unsent
 * work disappear from the screen.
 */

export type LocalChange =
  | {
      kind: 'work_order.transition';
      payload: { to: WorkOrderDetail['workOrder']['state']; reason?: string };
    }
  | { kind: 'work_order.checklist'; payload: { itemId: string; done: boolean } }
  | {
      kind: 'work_order.comment';
      payload: { commentId: string; body: string; visibility: 'internal' | 'customer' };
    }
  | { kind: 'site.access'; payload: { changes: AccessValues } };

export interface Actor {
  id: string;
  name: string;
}

const CLOSING = new Set(['complete', 'reviewed', 'cancelled']);

export function applyToJob(
  detail: WorkOrderDetail,
  change: LocalChange,
  actor: Actor,
  at: string,
): WorkOrderDetail {
  switch (change.kind) {
    case 'work_order.transition': {
      const to = change.payload.to;
      return {
        ...detail,
        workOrder: {
          ...detail.workOrder,
          state: to,
          stateChangedAt: at,
          lastReason: change.payload.reason ?? detail.workOrder.lastReason,
          completedAt: to === 'complete' ? at : detail.workOrder.completedAt,
          cancelledAt: to === 'cancelled' ? at : detail.workOrder.cancelledAt,
        },
      };
    }
    case 'work_order.checklist':
      return {
        ...detail,
        checklist: detail.checklist.map((item) =>
          item.id === change.payload.itemId
            ? {
                ...item,
                done: change.payload.done,
                doneBy: change.payload.done ? actor : null,
                doneAt: change.payload.done ? at : null,
              }
            : item,
        ),
      };
    case 'work_order.comment':
      return detail.comments.some((comment) => comment.id === change.payload.commentId)
        ? detail
        : {
            ...detail,
            comments: [
              ...detail.comments,
              {
                id: change.payload.commentId,
                author: actor,
                visibility: change.payload.visibility,
                body: change.payload.body,
                createdAt: at,
              },
            ],
          };
    case 'site.access':
      return {
        ...detail,
        site: {
          ...detail.site,
          access: { ...detail.site.access, ...definedOnly(change.payload.changes) },
        },
      };
  }
}

export function closedAtOf(detail: WorkOrderDetail): string | null {
  const { workOrder } = detail;
  if (!CLOSING.has(workOrder.state)) {
    return null;
  }
  return new Date(
    workOrder.completedAt ?? workOrder.cancelledAt ?? workOrder.stateChangedAt,
  ).toISOString();
}

function definedOnly(values: AccessValues): Partial<Record<keyof AccessValues, string | null>> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
