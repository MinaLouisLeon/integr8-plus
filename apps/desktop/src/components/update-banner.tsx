import { useTranslation } from '@integr8/i18n';
import { useEffect, useState } from 'react';
import { Button } from '~/components/ui';
import {
  type AvailableUpdate,
  CHECK_INTERVAL_MS,
  findUpdate,
  installerRestartsApp,
} from '~/lib/updates';

type Stage =
  | { kind: 'idle' }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'installing'; update: AvailableUpdate }
  | { kind: 'installed'; version: string }
  | { kind: 'failed'; update: AvailableUpdate };

/**
 * A strip under the top bar when a newer version of the app is ready.
 *
 * It asks rather than installs on its own: installing on Windows closes the
 * window, and somebody halfway through a form should choose the moment. It
 * can be left for later; it comes back on the next check.
 */
export function UpdateBanner({ initial }: { initial?: AvailableUpdate } = {}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>(
    initial === undefined ? { kind: 'idle' } : { kind: 'available', update: initial },
  );

  useEffect(() => {
    let cancelled = false;
    const look = () => {
      void findUpdate().then((update) => {
        if (!cancelled && update !== undefined) {
          setStage((current) =>
            current.kind === 'idle' ? { kind: 'available', update } : current,
          );
        }
      });
    };
    look();
    const timer = setInterval(look, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (stage.kind === 'idle') {
    return null;
  }

  if (stage.kind === 'installed') {
    return (
      <div role="status" className="bg-accent-subtle px-6 py-2 text-sm text-content">
        {t('workspace.appUpdate.installed', { version: stage.version })}
      </div>
    );
  }

  const install = () => {
    const update = stage.update;
    setStage({ kind: 'installing', update });
    update
      .install()
      .then(() => setStage({ kind: 'installed', version: update.version }))
      .catch((error: unknown) => {
        console.warn('Could not install the update', error);
        setStage({ kind: 'failed', update });
      });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 bg-accent-subtle px-6 py-2 text-sm text-content"
    >
      <span>
        {stage.kind === 'failed'
          ? t('workspace.appUpdate.failed', { version: stage.update.version })
          : t('workspace.appUpdate.available', { version: stage.update.version })}
        {installerRestartsApp() ? ` ${t('workspace.appUpdate.windowsRestart')}` : ''}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="primary"
          busy={stage.kind === 'installing'}
          disabled={stage.kind === 'installing'}
          onClick={install}
        >
          {stage.kind === 'installing'
            ? t('workspace.appUpdate.installing')
            : t('workspace.appUpdate.install')}
        </Button>
        {stage.kind === 'installing' ? null : (
          <Button variant="ghost" onClick={() => setStage({ kind: 'idle' })}>
            {t('workspace.appUpdate.later')}
          </Button>
        )}
      </span>
    </div>
  );
}
