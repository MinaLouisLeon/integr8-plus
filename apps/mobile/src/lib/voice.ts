/**
 * The assistant's voice on the phone, without the native parts (docs/ai §10.5).
 *
 * Pure: which language a member speaks, what a spoken question adds to the box,
 * which recogniser errors the person is told about, and the two device
 * preferences' names. The hooks that reach the phone's recogniser and voices
 * are in `components/voice.tsx`.
 */

/** Where a spoken question may be asked: only when a model answers. */
export function canSpeakQuestions(answerSource: 'model' | 'library'): boolean {
  return answerSource === 'model';
}

/** The recogniser's and the voices' language for the assistant's locale. */
export function speechLanguage(locale: 'en' | 'ar'): string {
  return locale === 'ar' ? 'ar-EG' : 'en-GB';
}

/** What is in the box after speaking: what was typed first, then the words heard. */
export function withSpoken(typedBefore: string, heard: string): string {
  const before = typedBefore.trimEnd();
  const words = heard.trim();
  return before === '' || words === '' ? `${before}${words}` : `${before} ${words}`;
}

/**
 * Why listening stopped before any words came. A refused microphone or speech
 * permission is `blocked`; no service, no network, no microphone or a language
 * the phone cannot recognise is `unavailable`; silence and our own stop are
 * not errors.
 */
export type SpeechProblem = 'blocked' | 'unavailable';

export function speechProblem(code: string | undefined): SpeechProblem | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'blocked';
    case 'no-speech':
    case 'aborted':
    case 'speech-timeout':
    case undefined:
      return null;
    default:
      return 'unavailable';
  }
}

/** Reading aloud is off until turned on; both choices stay on this phone. */
export const READ_ALOUD_KEY = 'integr8.assistant.readAloud';
export const READ_ALOUD_HINT_KEY = 'integr8.assistant.readAloudHint';

export interface ReadAloudChoice {
  enabled: boolean;
  hintDismissed: boolean;
}

/** The stored choice from the two raw values; anything unreadable means the defaults (off, hint shown). */
export function readAloudChoice(
  enabled: string | null,
  hintDismissed: string | null,
): ReadAloudChoice {
  return { enabled: enabled === 'on', hintDismissed: hintDismissed === 'dismissed' };
}

/** Whether the first-visit hint is shown: reading is off and the hint was not put away. */
export function showReadAloudHint(choice: ReadAloudChoice, supported: boolean): boolean {
  return supported && !choice.enabled && !choice.hintDismissed;
}
