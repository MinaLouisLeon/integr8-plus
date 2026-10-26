import type { MyQualification } from '@integr8/offline';
import { describe, expect, it } from 'vitest';
import { requirementStanding } from './qualifications';

const record = (typeId: string, state: MyQualification['state']) =>
  ({
    qualificationType: { id: typeId, name: typeId, kind: 'certificate' },
    state,
  }) as MyQualification;

describe('what a job needs, against the engineer’s own records', () => {
  it('counts any current record, renewals included', () => {
    expect(requirementStanding('gas', [record('gas', 'expired'), record('gas', 'valid')])).toBe(
      'held',
    );
    expect(requirementStanding('skill', [record('skill', 'no_expiry')])).toBe('held');
  });

  it('says when it is expiring, expired, or not held at all', () => {
    expect(requirementStanding('gas', [record('gas', 'expiring')])).toBe('expiring');
    expect(requirementStanding('gas', [record('gas', 'expired')])).toBe('expired');
    expect(requirementStanding('gas', [record('gas', 'removed'), record('elec', 'valid')])).toBe(
      'not_held',
    );
  });
});
