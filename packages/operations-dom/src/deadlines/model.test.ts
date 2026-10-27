import { describe, expect, it } from 'vitest';
import { joinMinutes, ruleDrafts, ruleProblem, rulesBody, share } from './model.js';

describe('deadline rules as hours and minutes', () => {
  it('reads empty boxes as no deadline, and refuses what is not a whole number of minutes', () => {
    expect(joinMinutes('', '')).toBeNull();
    expect(joinMinutes('2', '')).toBe(120);
    expect(joinMinutes('', '45')).toBe(45);
    expect(joinMinutes('1', '30')).toBe(90);
    expect(joinMinutes('0', '0')).toBeUndefined();
    expect(joinMinutes('1.5', '')).toBeUndefined();
    expect(joinMinutes('-1', '')).toBeUndefined();
    expect(joinMinutes('9000', '')).toBeUndefined();
  });

  it('gives every priority a draft, most urgent first, splitting minutes into hours', () => {
    const drafts = ruleDrafts(
      [
        {
          priority: 'high',
          responseMinutes: 90,
          completionMinutes: null,
          clock: 'working_hours',
          warnMinutes: 10,
        },
      ],
      30,
    );
    expect(drafts.map((draft) => draft.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(drafts[1]).toEqual({
      priority: 'high',
      responseHours: '1',
      responseMinutes: '30',
      completionHours: '',
      completionMinutes: '',
      clock: 'working_hours',
      warnMinutes: '10',
    });
    expect(drafts[0]!.warnMinutes).toBe('30');
  });

  it('says what is wrong with a draft, and leaves blank priorities out of the body', () => {
    const [urgent, high, normal, low] = ruleDrafts([], 30);
    const bad = { ...urgent!, responseHours: '4', completionHours: '2' };
    expect(ruleProblem(bad)).toBe('completionBeforeResponse');
    expect(ruleProblem({ ...urgent!, responseHours: 'x' })).toBe('invalid');
    expect(ruleProblem({ ...urgent!, responseHours: '1', warnMinutes: '' })).toBe('warnInvalid');
    expect(ruleProblem(low!)).toBeUndefined();
    expect(rulesBody([{ ...high!, completionHours: '8' }, normal!, low!, urgent!])).toEqual([
      {
        priority: 'high',
        responseMinutes: null,
        completionMinutes: 480,
        clock: 'always',
        warnMinutes: 30,
      },
    ]);
  });

  it('shares nothing when nothing was due', () => {
    expect(share(3, 4)).toBe(0.75);
    expect(share(0, 0)).toBeNull();
  });
});
