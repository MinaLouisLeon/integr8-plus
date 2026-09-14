import { useTranslation } from '@integr8/i18n';
import {
  FillStartScreen,
  type ScreensConfig,
  ScreensContext,
  SubmissionListScreen,
  SubmissionScreen,
} from '@integr8/form-renderer-dom/screens';
import { useMemo, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { session } from '~/lib/session';

/**
 * The submission screens, hosted by the desktop app.
 *
 * Shared with the web app; the desktop app supplies its keychain-backed session
 * client and hash routes.
 */
function FormScreens({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const config = useMemo<ScreensConfig>(
    () => ({
      client: session().client,
      locale: i18n.language,
      navigate: (to) => void navigate(to),
      paths: {
        fill: '/fill',
        submissions: '/submissions',
        submission: (id) => `/submissions/${id}`,
      },
      download: saveFile,
    }),
    [navigate, i18n.language],
  );
  return (
    <ScreensContext.Provider value={config}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
    </ScreensContext.Provider>
  );
}

/**
 * A browser download. In the Tauri window this is handed to the webview, which
 * saves to the downloads folder on Windows and macOS; a native save dialog is a
 * later refinement, not a requirement for exporting.
 */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function FillRoute() {
  return (
    <FormScreens>
      <FillStartScreen />
    </FormScreens>
  );
}

export function SubmissionsRoute() {
  return (
    <FormScreens>
      <SubmissionListScreen />
    </FormScreens>
  );
}

export function SubmissionRoute() {
  const { submissionId = '' } = useParams();
  return (
    <FormScreens>
      <SubmissionScreen key={submissionId} submissionId={submissionId} />
    </FormScreens>
  );
}
