import type { MyQualification } from '@integr8/offline';

/**
 * Whether the engineer holds what a job needs (P26), from their own records as
 * the phone last heard them. Judged on today, not on the visit's dates: the
 * office's board does that check; this tells the engineer what to raise.
 */
export type RequirementStanding = 'held' | 'expiring' | 'expired' | 'not_held';

export function requirementStanding(
  qualificationTypeId: string,
  mine: readonly MyQualification[],
): RequirementStanding {
  const states = new Set(
    mine
      .filter(
        (record) =>
          record.qualificationType.id === qualificationTypeId && record.state !== 'removed',
      )
      .map((record) => record.state),
  );
  if (states.has('valid') || states.has('no_expiry')) {
    return 'held';
  }
  if (states.has('expiring')) {
    return 'expiring';
  }
  return states.has('expired') ? 'expired' : 'not_held';
}
