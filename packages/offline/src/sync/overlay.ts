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
  | { kind: 'site.access'; payload: { changes: AccessValues } }
  | {
      kind: 'work_order.photo';
      payload: {
        attachmentId: string;
        mediaId: string;
        stage: 'before' | 'after';
        title: string;
        contentType: string;
        byteSize: number;
      };
    }
  | { kind: 'work_order.photo_remove'; payload: { attachmentId: string } }
  | {
      kind: 'work_order.signoff';
      payload:
        | { mediaId: string; name: string; role: string | null; signedAt: string }
        | { unavailableReason: string; signedAt: string };
    };

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
        // In the history too, so time on the job counts from the phone's own record (P14).
        events:
          detail.workOrder.state === to
            ? detail.events
            : [
                ...detail.events,
                {
                  kind: 'transitioned',
                  fromState: detail.workOrder.state,
                  toState: to,
                  person: null,
                  actor,
                  reason: change.payload.reason ?? null,
                  details: {},
                  occurredAt: at,
                  recordedAt: at,
                },
              ],
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
    case 'work_order.photo': {
      const { attachmentId, mediaId, stage, title, contentType, byteSize } = change.payload;
      return detail.attachments.some((attachment) => attachment.id === attachmentId)
        ? detail
        : {
            ...detail,
            attachments: [
              {
                id: attachmentId,
                fileId: mediaId,
                title,
                kind: 'photo',
                stage,
                contentType,
                byteSize,
                addedBy: actor,
                createdAt: at,
              },
              ...detail.attachments,
            ],
          };
    }
    case 'work_order.photo_remove':
      return {
        ...detail,
        attachments: detail.attachments.filter(
          (attachment) => attachment.id !== change.payload.attachmentId,
        ),
      };
    case 'work_order.signoff': {
      const { payload } = change;
      return {
        ...detail,
        execution: {
          ...detail.execution,
          signoff:
            'mediaId' in payload
              ? {
                  signedAt: payload.signedAt,
                  signedBy: actor,
                  fileId: payload.mediaId,
                  name: payload.name,
                  role: payload.role,
                  unavailableReason: null,
                }
              : {
                  signedAt: payload.signedAt,
                  signedBy: actor,
                  fileId: null,
                  name: null,
                  role: null,
                  unavailableReason: payload.unavailableReason,
                },
        },
      };
    }
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
