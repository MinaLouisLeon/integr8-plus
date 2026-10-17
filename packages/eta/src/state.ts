/**
 * An ETA document's life (PLAN §3). The invoice it came from never moves.
 *
 * SPEC-UNVERIFIED(status-values): `valid`, `invalid` and `cancelled` mirror
 * the ETA's `Valid`, `Invalid` and `Cancelled`; `rejected` is a document the
 * submission response refused outright.
 */

import { ETA_DOCUMENT_STATES, type EtaDocumentState } from '@integr8/core';

export { ETA_DOCUMENT_STATES, type EtaDocumentState };

const TRANSITIONS: Readonly<Record<EtaDocumentState, readonly EtaDocumentState[]>> = {
  ready: ['pending_signature', 'superseded'],
  pending_signature: ['signed', 'ready', 'superseded'],
  signed: ['submitting', 'superseded'],
  // A worker that loses its lease leaves `submitting`; the next attempt treats it as `unknown`.
  submitting: ['submitted', 'rejected', 'failed', 'unknown'],
  submitted: ['valid', 'invalid', 'cancelled', 'submitted'],
  valid: ['cancelled'],
  invalid: [],
  rejected: [],
  cancelled: [],
  // A definite failure before acceptance (credentials, a refused request): sent again from `signed`.
  failed: ['signed', 'superseded'],
  // No answer: a person says what happened.
  unknown: ['submitted', 'signed'],
  superseded: [],
};

export function canMove(from: EtaDocumentState, to: EtaDocumentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which the document is done: nothing more will happen to it here. */
export function isFinal(state: EtaDocumentState): boolean {
  return TRANSITIONS[state].length === 0 || state === 'valid';
}

/** States in which preparing the invoice again is allowed (it supersedes this one). */
export function canPrepareAgain(state: EtaDocumentState): boolean {
  return (
    TRANSITIONS[state].includes('superseded') ||
    state === 'invalid' ||
    state === 'rejected' ||
    state === 'cancelled'
  );
}
