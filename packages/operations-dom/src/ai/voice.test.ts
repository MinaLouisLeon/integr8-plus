import { describe, expect, it } from 'vitest';
import { speechInputError, speechLanguage, transcriptOf } from './voice.js';

/**
 * The pure parts of voice: which language a member's locale speaks, how the
 * recogniser's results become one line, and which of its errors the person is
 * told about. The hooks are exercised through the assistant screen's tests.
 */

describe('speechLanguage', () => {
  it('speaks Egyptian Arabic for Arabic members and British English otherwise', () => {
    expect(speechLanguage('ar')).toBe('ar-EG');
    expect(speechLanguage('en')).toBe('en-GB');
  });
});

describe('transcriptOf', () => {
  it('joins every result, final or not, and says whether all are final', () => {
    const results = Object.assign(
      [
        Object.assign([{ transcript: 'How do I ' }], { isFinal: true }),
        Object.assign([{ transcript: 'add a job' }], { isFinal: false }),
      ],
      { length: 2 },
    );
    expect(transcriptOf({ resultIndex: 1, results })).toEqual({
      text: 'How do I add a job',
      final: false,
    });
  });

  it('is final when every result is, and trims the ends', () => {
    const results = [Object.assign([{ transcript: ' Count them. ' }], { isFinal: true })];
    expect(transcriptOf({ resultIndex: 0, results })).toEqual({ text: 'Count them.', final: true });
  });
});

describe('speechInputError', () => {
  it('names a refused microphone as blocked', () => {
    expect(speechInputError('not-allowed')).toBe('blocked');
    expect(speechInputError('service-not-allowed')).toBe('blocked');
  });

  it('treats silence and a stop of our own as no error', () => {
    expect(speechInputError('no-speech')).toBeNull();
    expect(speechInputError('aborted')).toBeNull();
    expect(speechInputError(undefined)).toBeNull();
  });

  it('calls everything else unavailable', () => {
    expect(speechInputError('network')).toBe('unavailable');
    expect(speechInputError('audio-capture')).toBe('unavailable');
    expect(speechInputError('language-not-supported')).toBe('unavailable');
  });
});
