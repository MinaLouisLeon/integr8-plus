import { ApiRequestError } from '@integr8/api-client';
import type { FormDefinition } from '@integr8/form-engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveDraft } from './api';
import { clearLocalCopy, sameDefinition, writeLocalCopy } from './model/recovery';

/**
 * Autosave.
 *
 * Every edit is written to this device at once (for crash recovery) and sent
 * to the server shortly after the person stops typing. Each save names the
 * revision it is based on; if somebody else saved in between, the server
 * refuses, and this stops and says so rather than retrying over their work.
 *
 * Other failures — the network, a server restart — retry with a growing delay,
 * and the local copy is what keeps the edits safe meanwhile.
 */

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'failed' | 'conflict';

const QUIET_PERIOD_MS = 800;

interface Baseline {
  /** The draft's revision, or `null` when the server has no draft and the first save creates one. */
  revision: number | null;
  definition: unknown;
}

export interface DraftSync {
  status: SaveStatus;
  revision: number | null;
  /** Sends anything unsaved now, waits for it, and returns the revision the server holds. */
  flush: () => Promise<number | null>;
  /** After publishing, or loading someone else's version: this is what the server has. */
  reset: (baseline: Baseline) => void;
}

export function useDraftSync(options: {
  formId: string;
  recoveryKey: string | undefined;
  definition: FormDefinition;
  baseline: Baseline;
  enabled: boolean;
}): DraftSync {
  const { formId, recoveryKey, definition, enabled } = options;
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [revision, setRevision] = useState<number | null>(options.baseline.revision);

  const sync = useRef({
    revision: options.baseline.revision,
    saved: options.baseline.definition,
    latest: definition,
    inFlight: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    conflict: false,
    failures: 0,
  });

  const save = useCallback(async (): Promise<void> => {
    const state = sync.current;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    while (state.inFlight !== undefined) {
      await state.inFlight;
    }
    if (state.conflict) {
      return;
    }
    if (sameDefinition(state.latest, state.saved)) {
      setStatus('saved');
      if (recoveryKey !== undefined) {
        clearLocalCopy(recoveryKey);
      }
      return;
    }

    const sending = state.latest;
    setStatus('saving');
    state.inFlight = (async () => {
      try {
        const version = await saveDraft(formId, sending, state.revision);
        state.revision = version.revision;
        state.saved = sending;
        state.failures = 0;
        setRevision(version.revision);
        if (sameDefinition(state.latest, sending)) {
          setStatus('saved');
          if (recoveryKey !== undefined) {
            clearLocalCopy(recoveryKey);
          }
        } else {
          setStatus('pending');
        }
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'draft_conflict') {
          state.conflict = true;
          setStatus('conflict');
        } else {
          state.failures += 1;
          setStatus('failed');
        }
      } finally {
        state.inFlight = undefined;
      }
    })();
    await state.inFlight;
  }, [formId, recoveryKey]);

  // The timer reschedules itself after a save; through a ref, so the callback need not name itself.
  const reschedule = useRef<(delay: number) => void>(() => undefined);

  const schedule = useCallback(
    (delay: number) => {
      const state = sync.current;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void save().then(() => {
          // Edits made while saving, or a failure to retry.
          const after = sync.current;
          if (!after.conflict && !sameDefinition(after.latest, after.saved)) {
            reschedule.current(
              after.failures === 0
                ? QUIET_PERIOD_MS
                : Math.min(30_000, 1_000 * 2 ** after.failures),
            );
          }
        });
      }, delay);
    },
    [save],
  );

  useEffect(() => {
    reschedule.current = schedule;
  }, [schedule]);

  useEffect(() => {
    const state = sync.current;
    state.latest = definition;
    if (!enabled || state.conflict) {
      return;
    }
    if (sameDefinition(definition, state.saved)) {
      if (state.inFlight === undefined) {
        setStatus('saved');
      }
      if (recoveryKey !== undefined) {
        clearLocalCopy(recoveryKey);
      }
      return;
    }
    if (recoveryKey !== undefined) {
      writeLocalCopy(recoveryKey, {
        baseRevision: state.revision,
        definition: definition,
        savedAt: new Date().toISOString(),
      });
    }
    if (state.inFlight === undefined) {
      setStatus('pending');
    }
    schedule(QUIET_PERIOD_MS);
  }, [definition, enabled, recoveryKey, schedule]);

  // Leaving with unsaved edits: the browser asks. The local copy is the safety net either way.
  useEffect(() => {
    if (status === 'saved' || status === 'conflict') {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  useEffect(
    () => () => {
      const state = sync.current;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
      }
    },
    [],
  );

  const flush = useCallback(async () => {
    await save();
    return sync.current.revision;
  }, [save]);

  const reset = useCallback(
    (baseline: Baseline) => {
      const state = sync.current;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.revision = baseline.revision;
      state.saved = baseline.definition;
      state.conflict = false;
      state.failures = 0;
      setRevision(baseline.revision);
      setStatus(sameDefinition(state.latest, baseline.definition) ? 'saved' : 'pending');
      if (!sameDefinition(state.latest, baseline.definition)) {
        schedule(QUIET_PERIOD_MS);
      } else if (recoveryKey !== undefined) {
        clearLocalCopy(recoveryKey);
      }
    },
    [recoveryKey, schedule],
  );

  return { status, revision, flush, reset };
}
