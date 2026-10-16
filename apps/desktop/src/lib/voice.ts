import type { VoiceInput } from '@integr8/operations-dom';
import { isTauri } from './platform';

/**
 * Where a spoken question to the assistant comes from in this app.
 *
 * In a browser tab the shared screens use the browser's own recogniser, so
 * nothing is said here. In the Tauri window that recogniser is absent: the
 * embedded web view (WebView2, WKWebView) exposes the API but has no speech
 * service behind it. The operating system's dictation does the job instead,
 * typing into the focused box, and the screen tells the person which key
 * starts it. Linux has no standard dictation, so it gets no microphone button.
 */

interface NavigatorLike {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

export function desktopVoiceInput(
  navigatorLike: NavigatorLike | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): VoiceInput | undefined {
  if (!isTauri()) {
    return undefined;
  }
  switch (operatingSystem(navigatorLike)) {
    case 'windows':
      return { kind: 'dictation', os: 'windows' };
    case 'macos':
      return { kind: 'dictation', os: 'macos' };
    default:
      return { kind: 'none' };
  }
}

/** The operating system under the window, as far as the web view says. */
export function operatingSystem(
  navigatorLike: NavigatorLike | undefined,
): 'windows' | 'macos' | 'other' {
  const hint = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (hint.includes('win')) {
    return 'windows';
  }
  if (hint.includes('mac')) {
    return 'macos';
  }
  return 'other';
}
