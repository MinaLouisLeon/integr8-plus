import { createContext, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice for the assistant (docs/ai §10.5; ADR-0002 D13–D14), with the device's
 * own tools and nothing else.
 *
 * A spoken question goes through the browser's speech recognition and arrives
 * as text, so the server never hears audio and nothing here costs the company
 * a token. Answers are read aloud by the voices installed on the machine. Both
 * halves are feature-detected, and a browser without one simply shows no
 * button for it.
 *
 * Reading aloud is off until the person turns it on, and the choice is kept
 * on this device only (`localStorage`: a preference, not a secret).
 */

/** Where a spoken question can come from on the app hosting the screens. */
export type VoiceInput =
  /** The browser's own speech recognition (Chrome, Edge); the website. */
  | { kind: 'browser' }
  /**
   * The operating system's dictation, which types into the focused box: the
   * desktop app, whose embedded web view has no recognition service of its own.
   */
  | { kind: 'dictation'; os: 'windows' | 'macos' }
  | { kind: 'none' };

export const READ_ALOUD_KEY = 'integr8.assistant.readAloud';
export const READ_ALOUD_HINT_KEY = 'integr8.assistant.readAloudHint';

/** The recogniser's and the voices' language for a member's locale. */
export function speechLanguage(locale: 'en' | 'ar'): string {
  return locale === 'ar' ? 'ar-EG' : 'en-GB';
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/* ------------------------------------------------------------------------ */
/* Speaking a question                                                      */
/* ------------------------------------------------------------------------ */

/** The part of the Web Speech API's recogniser this module touches. */
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  processLocally?: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface RecognitionConstructor {
  new (): RecognitionLike;
  /** Chrome 139+: whether the device can recognise this language itself. */
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

/** The browser's recogniser, or null where there is none (Firefox, Safari on some platforms). */
export function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Why listening stopped before any words came, in the person's terms. The
 * microphone refused is `blocked`; no service, no network or no microphone is
 * `unavailable`; silence and a stop of our own are not errors at all.
 */
export type SpeechInputError = 'blocked' | 'unavailable';

export function speechInputError(code: string | undefined): SpeechInputError | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'blocked';
    case 'no-speech':
    case 'aborted':
    case undefined:
      return null;
    default:
      return 'unavailable';
  }
}

/**
 * The spoken words so far: everything final, then whatever is still being
 * heard, as one line.
 */
export function transcriptOf(event: RecognitionResultEvent): { text: string; final: boolean } {
  const parts: string[] = [];
  let final = true;
  for (const result of Array.from(event.results)) {
    parts.push(result[0]?.transcript ?? '');
    final = final && result.isFinal;
  }
  return { text: parts.join('').trim(), final };
}

export interface SpeechInput {
  /** False where the browser has no recogniser; the button is not shown. */
  supported: boolean;
  listening: boolean;
  error: SpeechInputError | null;
  start(): void;
  stop(): void;
}

/**
 * One recogniser for the composer. `onTranscript` is called with the words
 * heard so far, and once more with `final` when the person stops speaking;
 * the caller decides where they go.
 */
export function useSpeechInput(options: {
  lang: string;
  enabled: boolean;
  onTranscript: (text: string, final: boolean) => void;
}): SpeechInput {
  const { lang, enabled, onTranscript } = options;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<SpeechInputError | null>(null);
  const current = useRef<RecognitionLike | null>(null);
  const latest = useRef(onTranscript);
  useEffect(() => {
    latest.current = onTranscript;
  });

  const Recognition = enabled ? recognitionConstructor() : null;
  const supported = Recognition !== null;

  const stop = useCallback(() => {
    current.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (Recognition === null || current.current !== null) {
      return;
    }
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const { text, final } = transcriptOf(event);
      latest.current(text, final);
    };
    recognition.onerror = (event) => {
      setError(speechInputError(event.error));
    };
    recognition.onend = () => {
      current.current = null;
      setListening(false);
    };
    current.current = recognition;
    setError(null);
    setListening(true);
    void (async () => {
      // Where the device can recognise the language itself, keep the audio on
      // it; the cloud is the fallback, not the default.
      try {
        if (Recognition.available !== undefined) {
          const state = await Recognition.available({ langs: [lang], processLocally: true });
          if (state === 'available') {
            recognition.processLocally = true;
          }
        }
      } catch {
        // An older browser without the query recognises as it always did.
      }
      try {
        recognition.start();
      } catch {
        current.current = null;
        setListening(false);
        setError('unavailable');
      }
    })();
  }, [Recognition, lang]);

  // Leaving the screen stops the microphone with it.
  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
    },
    [],
  );

  return { supported, listening, error, start, stop };
}

/* ------------------------------------------------------------------------ */
/* Reading an answer aloud                                                  */
/* ------------------------------------------------------------------------ */

/** The part of `speechSynthesis` this module touches. */
interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}

interface UtteranceLike {
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function synthesis(): SynthesisLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const scope = window as unknown as {
    speechSynthesis?: SynthesisLike;
    SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
  };
  return scope.speechSynthesis !== undefined && scope.SpeechSynthesisUtterance !== undefined
    ? scope.speechSynthesis
    : null;
}

export interface ReadAloud {
  /** False where the machine has no voices to offer; nothing about reading is shown. */
  supported: boolean;
  /** Whether every answer is read as it arrives. Off until the person turns it on. */
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** The first-visit hint stays until reading is turned on or the hint is dismissed. */
  hintShown: boolean;
  dismissHint(): void;
  /** The id of the message being read, or null. */
  speakingId: string | null;
  speak(id: string, text: string): void;
  stop(): void;
}

export function useReadAloud(options: { lang: string }): ReadAloud {
  const { lang } = options;
  const synth = synthesis();
  const supported = synth !== null;
  const [enabled, setEnabledState] = useState(() => readStored(READ_ALOUD_KEY) === 'on');
  const [hintDismissed, setHintDismissed] = useState(
    () => readStored(READ_ALOUD_HINT_KEY) === 'dismissed',
  );
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const stop = useCallback(() => {
    synth?.cancel();
    setSpeakingId(null);
  }, [synth]);

  const speak = useCallback(
    (id: string, text: string) => {
      if (synth === null || text.trim() === '') {
        return;
      }
      synth.cancel();
      const Utterance = (
        window as unknown as { SpeechSynthesisUtterance: new (t: string) => UtteranceLike }
      ).SpeechSynthesisUtterance;
      const utterance = new Utterance(text);
      utterance.lang = lang;
      const finished = () => setSpeakingId((speaking) => (speaking === id ? null : speaking));
      utterance.onend = finished;
      utterance.onerror = finished;
      setSpeakingId(id);
      synth.speak(utterance);
    },
    [synth, lang],
  );

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    writeStored(READ_ALOUD_HINT_KEY, 'dismissed');
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      writeStored(READ_ALOUD_KEY, next ? 'on' : 'off');
      if (next) {
        dismissHint();
      } else {
        stop();
      }
    },
    [dismissHint, stop],
  );

  // Leaving the screen silences it.
  useEffect(() => () => synth?.cancel(), [synth]);

  return {
    supported,
    enabled,
    setEnabled,
    hintShown: supported && !enabled && !hintDismissed,
    dismissHint,
    speakingId,
    speak,
    stop,
  };
}

/** Reading aloud, for the message list under the assistant's header. Null where the screen offers none. */
export const ReadAloudContext = createContext<ReadAloud | null>(null);
