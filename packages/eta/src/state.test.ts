import { describe, expect, it } from 'vitest';
import { canMove, canPrepareAgain, ETA_DOCUMENT_STATES, isFinal } from './state.js';

describe('the ETA document state machine', () => {
  it('cannot submit what was never signed', () => {
    expect(canMove('ready', 'submitting')).toBe(false);
    expect(canMove('pending_signature', 'submitting')).toBe(false);
    expect(canMove('signed', 'submitting')).toBe(true);
  });

  it('treats an accepted submission as not yet valid', () => {
    expect(canMove('submitting', 'valid')).toBe(false);
    expect(canMove('submitting', 'submitted')).toBe(true);
    expect(canMove('submitted', 'valid')).toBe(true);
  });

  it('never resubmits an unknown outcome on its own', () => {
    expect(canMove('unknown', 'submitting')).toBe(false);
    expect(canMove('unknown', 'signed')).toBe(true);
    expect(canMove('unknown', 'submitted')).toBe(true);
  });

  it('knows its final states', () => {
    expect(ETA_DOCUMENT_STATES.filter(isFinal)).toEqual([
      'valid',
      'invalid',
      'rejected',
      'cancelled',
      'superseded',
    ]);
    expect(canPrepareAgain('submitted')).toBe(false);
    expect(canPrepareAgain('invalid')).toBe(true);
    expect(canPrepareAgain('ready')).toBe(true);
  });
});
