import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import * as Speech from 'expo-speech';
import Storage from 'expo-sqlite/kv-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  READ_ALOUD_HINT_KEY,
  READ_ALOUD_KEY,
  readAloudChoice,
  showReadAloudHint,
  speechProblem,
  type SpeechProblem,
  withSpoken,
} from '~/lib/voice';

/**
 * The assistant's voice on the phone (docs/ai §10.5), with the phone's own
 * recogniser and voices: no audio leaves the phone for Integr8, and a spoken
 * question reaches the server as text like a typed one.
 *
 * The native modules are absent in a unit test and in Expo Go builds that lack
 * them, so every call is guarded: a phone that cannot listen or speak simply
 * shows no button for it.
 */

function stored(key: string): string | null {
  try {
    return Storage.getItemSync(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    Storage.setItemSync(key, value);
  } catch {
    // The choice lasts until the screen closes.
  }
}

/* ------------------------------------------------------------------------ */
/* Speaking a question                                                      */
/* ------------------------------------------------------------------------ */

export interface SpokenQuestion {
  /** False where the phone has no recogniser; the button is not shown. */
  supported: boolean;
  listening: boolean;
  problem: SpeechProblem | null;
  /** Asks for the permissions the first time, then listens. */
  start(): void;
  stop(): void;
}

/**
 * Listens and hands over the box's new text: what was typed when listening
 * began, then the words heard so far.
 */
export function useSpokenQuestion(options: {
  lang: string;
  text: string;
  enabled: boolean;
  onText: (text: string) => void;
}): SpokenQuestion {
  const { lang, enabled, onText } = options;
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<SpeechProblem | null>(null);
  const typedBefore = useRef('');
  const latestText = useRef(options.text);
  const latestOnText = useRef(onText);
  useEffect(() => {
    latestText.current = options.text;
    latestOnText.current = onText;
  });

  const supported = enabled && recogniserAvailable();

  useSpeechRecognitionEvent('result', (event) => {
    const heard = event.results[0]?.transcript ?? '';
    latestOnText.current(withSpoken(typedBefore.current, heard));
  });
  useSpeechRecognitionEvent('error', (event) => {
    setProblem(speechProblem(event.error));
  });
  useSpeechRecognitionEvent('end', () => setListening(false));

  const start = useCallback(() => {
    if (!supported) {
      return;
    }
    setProblem(null);
    typedBefore.current = latestText.current;
    void (async () => {
      try {
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) {
          setProblem('blocked');
          return;
        }
        setListening(true);
        ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: false });
      } catch {
        setListening(false);
        setProblem('unavailable');
      }
    })();
  }, [supported, lang]);

  const stop = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      setListening(false);
    }
  }, []);

  // Leaving the screen stops the microphone with it.
  useEffect(
    () => () => {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // Nothing was listening.
      }
    },
    [],
  );

  return { supported, listening, problem, start, stop };
}

function recogniserAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Reading an answer aloud                                                  */
/* ------------------------------------------------------------------------ */

export interface ReadAloud {
  /** False where the phone has no voice engine; nothing about reading is shown. */
  supported: boolean;
  /** Whether every answer is read as it arrives. Off until the person turns it on. */
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  hintShown: boolean;
  dismissHint(): void;
  /** The id of the message being read, or null. */
  speakingId: string | null;
  speak(id: string, text: string): void;
  stop(): void;
}

export function useReadAloud(options: { lang: string }): ReadAloud {
  const { lang } = options;
  const [choice, setChoice] = useState(() =>
    readAloudChoice(stored(READ_ALOUD_KEY), stored(READ_ALOUD_HINT_KEY)),
  );
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const supported = typeof Speech.speak === 'function';

  const stop = useCallback(() => {
    try {
      void Speech.stop();
    } catch {
      // Nothing was speaking.
    }
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    (id: string, text: string) => {
      if (!supported || text.trim() === '') {
        return;
      }
      const finished = () => setSpeakingId((speaking) => (speaking === id ? null : speaking));
      setSpeakingId(id);
      try {
        Speech.speak(text, {
          language: lang,
          onDone: finished,
          onStopped: finished,
          onError: finished,
        });
      } catch {
        finished();
      }
    },
    [supported, lang],
  );

  const dismissHint = useCallback(() => {
    setChoice((current) => ({ ...current, hintDismissed: true }));
    store(READ_ALOUD_HINT_KEY, 'dismissed');
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setChoice({ enabled, hintDismissed: true });
      store(READ_ALOUD_KEY, enabled ? 'on' : 'off');
      if (enabled) {
        store(READ_ALOUD_HINT_KEY, 'dismissed');
      } else {
        stop();
      }
    },
    [stop],
  );

  // Leaving the screen silences it.
  useEffect(() => stop, [stop]);

  return {
    supported,
    enabled: choice.enabled,
    setEnabled,
    hintShown: showReadAloudHint(choice, supported),
    dismissHint,
    speakingId,
    speak,
    stop,
  };
}
