import { describe, expect, it } from 'vitest';
import {
  canSpeakQuestions,
  readAloudChoice,
  showReadAloudHint,
  speechLanguage,
  speechProblem,
  withSpoken,
} from './voice';

describe('who may speak a question', () => {
  it('is a company whose answers come from a model, and not one answered from the library', () => {
    expect(canSpeakQuestions('model')).toBe(true);
    expect(canSpeakQuestions('library')).toBe(false);
  });
});

describe('speechLanguage', () => {
  it('speaks Egyptian Arabic for Arabic and British English otherwise', () => {
    expect(speechLanguage('ar')).toBe('ar-EG');
    expect(speechLanguage('en')).toBe('en-GB');
  });
});

describe('withSpoken', () => {
  it('puts the heard words after what was typed, with one space', () => {
    expect(withSpoken('Quick one: ', 'count the boilers')).toBe('Quick one: count the boilers');
    expect(withSpoken('', ' How do I add a job ')).toBe('How do I add a job');
  });

  it('keeps the typed words when nothing was heard', () => {
    expect(withSpoken('Quick one:', '')).toBe('Quick one:');
  });
});

describe('speechProblem', () => {
  it('calls a refused microphone or speech permission blocked', () => {
    expect(speechProblem('not-allowed')).toBe('blocked');
    expect(speechProblem('service-not-allowed')).toBe('blocked');
  });

  it('says nothing about silence, a timeout or a stop of our own', () => {
    for (const code of ['no-speech', 'aborted', 'speech-timeout', undefined]) {
      expect(speechProblem(code)).toBeNull();
    }
  });

  it('calls anything else unavailable', () => {
    for (const code of ['network', 'audio-capture', 'language-not-supported', 'busy']) {
      expect(speechProblem(code)).toBe('unavailable');
    }
  });
});

describe('the read-aloud choice', () => {
  it('starts off with the hint showing when nothing is stored', () => {
    const choice = readAloudChoice(null, null);
    expect(choice).toEqual({ enabled: false, hintDismissed: false });
    expect(showReadAloudHint(choice, true)).toBe(true);
  });

  it('reads back what was stored', () => {
    expect(readAloudChoice('on', null).enabled).toBe(true);
    expect(readAloudChoice('off', 'dismissed')).toEqual({ enabled: false, hintDismissed: true });
    expect(readAloudChoice('garbage', 'garbage')).toEqual({ enabled: false, hintDismissed: false });
  });

  it('shows the hint only while reading is off, not put away, and the phone has a voice', () => {
    expect(showReadAloudHint({ enabled: true, hintDismissed: false }, true)).toBe(false);
    expect(showReadAloudHint({ enabled: false, hintDismissed: true }, true)).toBe(false);
    expect(showReadAloudHint({ enabled: false, hintDismissed: false }, false)).toBe(false);
  });
});
