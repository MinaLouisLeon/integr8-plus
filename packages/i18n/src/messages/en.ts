/**
 * English messages — the source language.
 *
 * TypeScript rather than JSON, so that `t('auth.signIn')` is a compile error
 * when the key is wrong and an autocomplete when it is not. That is most of
 * what makes P05's "no hardcoded strings" criterion enforceable: a developer
 * who cannot remember a key is shown the list rather than tempted to type the
 * sentence.
 *
 * Two rules for anybody adding to this file:
 *
 * - **A key names the meaning, not the words.** `auth.signIn`, not
 *   `auth.signInButton`, and never `auth.sign_in_blue_button`. The words change;
 *   the meaning is what a translator is given.
 * - **Never assemble a sentence from fragments.** Word order differs between
 *   languages, and in Arabic so does direction. Interpolation and plurals are
 *   what `{{count}}` and `_other` are for.
 */

export const en = {
  common: {
    appName: 'Integr8 Plus',
    loading: 'Loading…',
    retry: 'Try again',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    signOut: 'Sign out',
    theme: {
      label: 'Theme',
      light: 'Light',
      dark: 'Dark',
      system: 'Match my system',
    },
    language: 'Language',
    // Development-only, and named so it is obvious in a translation file why
    // it exists: forcing right-to-left is how the layout is checked before any
    // Arabic copy exists.
    forceRtl: 'Preview right-to-left',
    // Also development-only: the desktop app shows whether it is a Tauri window
    // or a browser tab, so P05's "identical in both" criterion can be checked
    // by eye. Translated anyway, because a string on screen is a string on
    // screen.
    runtime: 'Runtime',
  },

  auth: {
    signInTitle: 'Sign in',
    signInSubtitle: 'Use the address your company invited.',
    email: 'Email address',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    magicLink: 'Email me a sign-in link',
    magicLinkSent: 'If that address has an account, a sign-in link is on its way.',
    signedOut: 'You have been signed out.',
    sessionExpired: 'Your session has expired. Please sign in again.',
    switchCompany: 'Switch company',
    // One message for a wrong password, an unknown address and an account with
    // no company. Distinguishing them would turn the form into a way of testing
    // which addresses are customers.
    invalidCredentials: 'That email address and password did not match.',
    accountLocked: 'Too many attempts. Try again in a few minutes.',
    rateLimited: 'Too many requests. Slow down and try again shortly.',
  },

  workspace: {
    signedInAs: 'Signed in as {{name}}',
    company: 'Company',
    role: {
      owner: 'Owner',
      admin: 'Admin',
      dispatcher: 'Dispatcher',
      engineer: 'Engineer',
      viewer: 'Viewer',
    },
    members: {
      title: 'People',
      count_one: '{{count}} person',
      count_other: '{{count}} people',
      empty: 'Nobody else has joined yet.',
      invite: 'Invite somebody',
    },
    sessions: {
      title: 'Your devices',
      empty: 'No other devices are signed in.',
      current: 'This device',
      lastSeen: 'Last used {{when}}',
      revoke: 'Sign out this device',
    },
    impersonationBanner: 'You are viewing this account as {{name}}. Everything you do is recorded.',
  },

  errors: {
    title: 'Something went wrong',
    // The request id is the one thing that makes a report actionable, so the
    // copy asks for it rather than hoping somebody thinks to include it.
    body: 'We could not complete that. If it keeps happening, quote this reference: {{requestId}}',
    offline: 'You appear to be offline. This will retry when you reconnect.',
    notFound: 'We could not find that.',
    forbidden: 'You do not have permission to do that.',
    clientTooOld: 'This version of the app is no longer supported. Please update to continue.',
    unexpected: 'An unexpected error occurred.',
  },

  states: {
    emptyTitle: 'Nothing here yet',
    emptyBody: 'When there is something to show, it will appear here.',
    loadingLabel: 'Loading',
  },

  form: {
    // One message per error code the form engine produces, keyed by the code
    // itself. The engine's `FIELD_ERROR_CODES` is the contract; a test in this
    // package fails if a code has no message here. Interpolated values arrive
    // already formatted as text — a minimum of 2.50 is "2.50" — so nothing here
    // re-formats a number and loses a trailing zero.
    errors: {
      required: 'This is required.',
      invalid: 'This is not a valid answer.',
      too_short: 'Enter at least {{minimum}} characters.',
      too_long: 'Enter no more than {{maximum}} characters.',
      pattern_mismatch: 'This is not in the expected format.',
      below_minimum: 'Must be at least {{minimum}}.',
      above_maximum: 'Must be no more than {{maximum}}.',
      too_many_decimal_places: 'Use no more than {{maximum}} decimal places.',
      before_earliest: 'Must be {{earliest}} or later.',
      after_latest: 'Must be {{latest}} or earlier.',
      unknown_option: 'Choose one of the options given.',
      duplicate_option: 'Each option can only be chosen once.',
      too_few_selected: 'Choose at least {{minimum}}.',
      too_many_selected: 'Choose no more than {{maximum}}.',
      too_few_files: 'Add at least {{minimum}}.',
      too_many_files: 'Add no more than {{maximum}}.',
      file_too_large: 'Each file must be smaller than {{maximum}} bytes.',
      file_type_not_accepted: 'This type of file is not accepted here.',
      out_of_range: 'Choose a value from {{minimum}} to {{maximum}}.',
      accuracy_too_low:
        'The location is not accurate enough. Wait for a better signal (within {{maximum}} metres).',
      // Shown only when the rule's author wrote no message of their own, which a
      // published form always carries. The fallback exists so a screen never
      // renders a raw key.
      rule_failed: 'This answer does not meet a rule on this form.',
    },
  },
} as const;

export type Messages = typeof en;
