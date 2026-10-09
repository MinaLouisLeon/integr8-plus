/**
 * The one way browser code writes a preference cookie.
 *
 * The layouts that read these are server components, so a preference is a
 * cookie rather than state: the server has to see it to render the first byte
 * right. A year, because a preference forgotten every session is a preference
 * nobody set.
 */

const YEAR = 60 * 60 * 24 * 365;

export function rememberCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${String(YEAR)}; samesite=lax`;
}

export function forgetCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

/** The preference cookies, named once so the server layouts and the controls agree. */
export const LOCALE_COOKIE = 'integr8_locale';
export const THEME_COOKIE = 'integr8_theme';
export const SIDEBAR_COOKIE = 'integr8_sidebar';
