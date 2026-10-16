import { AI_POLICY_OFF } from '@integr8/core';
import type { TFunction } from '@integr8/i18n';
import { describe, expect, it } from 'vitest';
import {
  draftFromPolicy,
  draftProblems,
  pickPolicyFields,
  policyFromDraft,
} from './ai-policy-editor';

/** The key itself: enough to see which rule spoke. */
const t = ((key: string) => key) as unknown as TFunction;

describe('where answers come from, in the policy editor (ADR-0002 D9, D10)', () => {
  it('reads a policy without the field as model answers, and saves the choice', () => {
    const { answerSource: _omitted, ...older } = { ...AI_POLICY_OFF, level: 'help' as const };
    void _omitted;
    const draft = draftFromPolicy(older);
    expect(draft.answerSource).toBe('model');
    expect(policyFromDraft({ ...draft, answerSource: 'library' }).answerSource).toBe('library');
  });

  it('asks no cost cap of unlimited library answers, and still asks it of a model', () => {
    const unlimited = {
      ...draftFromPolicy({ ...AI_POLICY_OFF, level: 'help' }),
      unlimitedMessages: true,
      monthlyCostCapUsd: '',
    };
    expect(draftProblems({ ...unlimited, answerSource: 'library' }, t)).toEqual({});
    expect(draftProblems({ ...unlimited, answerSource: 'model' }, t)).toEqual({
      monthlyCostCapUsd: 'platform.ai.capRequired',
    });
  });

  it('sends the answer source back only when the record carried one', () => {
    expect(pickPolicyFields({ ...AI_POLICY_OFF, answerSource: 'library' }).answerSource).toBe(
      'library',
    );
    const { answerSource: _omitted, ...older } = AI_POLICY_OFF;
    void _omitted;
    expect('answerSource' in pickPolicyFields(older)).toBe(false);
  });
});
