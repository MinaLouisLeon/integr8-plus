import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en, type Messages } from './messages/en.js';
import { ar, type Catalogue } from './messages/ar.js';
import { DEFAULT_LOCALE, type Locale } from './locales.js';

/**
 * `@integr8/i18n` — one translation layer for three React runtimes.
 *
 * The Next.js app, the desktop SPA and the React Native app all use this, with
 * one set of messages and one set of keys. Using a Next-specific library would
 * have meant two message formats and two ways to write the same string, in a
 * phase whose entire point is that every screen built afterwards inherits this
 * for free.
 *
 * English and Arabic are both translated and both registered here, so an app
 * gets Arabic words in a right-to-left layout without passing `resources`.
 * Anything Arabic lacks falls back to English, which is what `fallbackLng`
 * below is for. See `locales.ts`.
 */

export * from './core.js';

export const DEFAULT_NAMESPACE = 'translation';

export interface CreateI18nOptions {
  locale?: Locale;
  /**
   * Messages to add or override, per locale. English and Arabic are built in;
   * a catalogue passed here for either replaces the built-in one.
   */
  resources?: Partial<Record<Locale, Messages | Catalogue<Messages>>>;
  debug?: boolean;
}

/**
 * Builds an i18next instance.
 *
 * A new instance per call rather than the shared singleton, because the Next.js
 * app renders on a server that handles several requests at once, and a
 * singleton there would let one request's locale leak into another's response.
 */
export function createI18n(options: CreateI18nOptions = {}): I18nInstance {
  const locale = options.locale ?? DEFAULT_LOCALE;

  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: locale,
    // Falling back to English is what makes a key Arabic has not caught up
    // with show real words rather than raw keys — the difference between a
    // usable screen and one full of `workspace.members.title`.
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: DEFAULT_NAMESPACE,
    resources: {
      en: { [DEFAULT_NAMESPACE]: en },
      ar: { [DEFAULT_NAMESPACE]: ar },
      ...Object.fromEntries(
        Object.entries(options.resources ?? {}).map(([code, messages]) => [
          code,
          { [DEFAULT_NAMESPACE]: messages },
        ]),
      ),
    },
    interpolation: {
      // React escapes for us. Escaping twice turns an apostrophe into `&#39;`
      // on screen, which is the classic symptom.
      escapeValue: false,
    },
    returnNull: false,
    debug: options.debug ?? false,
  });

  return instance;
}

export { useTranslation, Trans, I18nextProvider } from 'react-i18next';
export type { i18n as I18nInstance, TFunction } from 'i18next';

/**
 * Types `t()` against the English messages.
 *
 * With this, `t('auth.signIn')` autocompletes and `t('auth.signin')` is a
 * compile error. It is most of what makes "no hardcoded strings" enforceable:
 * a developer who cannot remember a key is shown the list rather than tempted
 * to type the sentence.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: { translation: Messages };
    returnNull: false;
  }
}
