# The four applications

| App            | Stack                                         | Tokens live where        |
| -------------- | --------------------------------------------- | ------------------------ |
| `apps/web`     | Next.js App Router                            | httpOnly cookie (server) |
| `apps/desktop` | Vite + React, wrapped by Tauri v2             | OS keychain              |
| `apps/mobile`  | Expo + React Native + expo-router             | SecureStore              |
| `apps/api`     | Fastify — see [`docs/api/`](../api/README.md) | —                        |

---

## What is shared, and what is not

**Shared:** design tokens, translations, the generated API client, and the
session logic that sits on top of it. All four are packages under `packages/`.

**Not shared: widgets.** P01's rule, and it holds. React DOM and React Native do
not share components usefully, and the web and desktop apps — both DOM today —
are about to diverge over window chrome, keyboard shortcuts and menu
integration. Each app has its own `components/ui`, and they are allowed to look
similar.

```
packages/tokens      colour, spacing, type scale — plain TypeScript
packages/i18n        i18next, the message catalogue, locale-aware formatting
packages/api-client  generated types + SessionManager
```

## Tokens

`@integr8/tokens` is **data, not CSS**, because React Native cannot use CSS.

- The two DOM apps import `@integr8/tokens/theme.css`, a generated stylesheet
  that declares every token as a CSS custom property and maps it into Tailwind
  v4's theme. `bg-surface` and `text-content-muted` are real utilities.
- The mobile app imports the TypeScript directly and reads `colours.light.text`.

A screen never names a raw colour. It names a semantic token — `surface`,
`danger`, `textMuted` — so that changing the warning colour is one edit rather
than a search for every amber in the product.

```bash
pnpm --filter @integr8/tokens css   # regenerate theme.css after editing tokens
```

`theme.css` is generated and committed, and excluded from Prettier: formatting a
file that is rewritten wholesale would make `pnpm format` and the generator
disagree about what it should contain.

## Translation

One library across all three React runtimes: **i18next**. A Next-specific
library would have meant two message formats and two ways to write the same
string, in a phase whose whole point is that every later screen inherits this
for free.

Messages live in `packages/i18n/src/messages/en.ts` — TypeScript, not JSON, so
`t('auth.signIn')` autocompletes and `t('auth.signin')` is a compile error.

Two rules when adding one:

- **The key names the meaning, not the words.** `auth.signIn`, never
  `auth.signInBlueButton`. Words change; meaning is what a translator receives.
- **Never assemble a sentence from fragments.** Word order differs between
  languages, and in Arabic so does direction. Use interpolation (`{{name}}`) and
  plural keys (`count_one` / `count_other`).

### Checking for strings that slipped through

```bash
grep -rnE '>[[:space:]]*[A-Z][a-z]+[a-z ]{2,}[[:space:]]*<'   apps/web/src apps/desktop/src apps/mobile/app apps/mobile/src   --include='*.tsx' | grep -v '\.test\.'
```

It should return exactly two lines, both error boundaries:

- `apps/web/src/app/global-error.tsx`
- `apps/desktop/src/main.tsx`

Those two render when the React tree itself threw, which means no provider is
mounted and `t()` cannot be reached. They are the only places in the product
where a literal string is correct, and both are deliberately short.

Anything else in that output is a string no translator will ever see.

The API's error messages are never shown to a person. They are written for a
developer reading a log, they are not translated, and for a failed sign-in the
same sentence is returned whatever went wrong. Each app maps the error `code` —
which is the contract — to its own translated copy.

## Right-to-left, from the first screen

Arabic is declared in `packages/i18n/src/locales.ts` with **no Arabic copy
behind it**. Selecting it gives English words in a mirrored layout, which is
exactly the check: it proves a screen was built with logical properties rather
than hardcoded `left` and `right`.

This is why the RTL task sits in P05 and not in P32. Checking each screen as it
is built costs nothing; retrofitting is a rewrite.

### The rules

| Context           | Wrong                   | Right                   |
| ----------------- | ----------------------- | ----------------------- |
| Tailwind spacing  | `ml-4`, `pr-2`          | `ms-4`, `pe-2`          |
| Tailwind text     | `text-left`             | `text-start`            |
| Tailwind borders  | `border-l`, `rounded-r` | `border-s`, `rounded-e` |
| Tailwind position | `left-0`                | `start-0`               |
| React Native box  | `paddingLeft`           | `paddingStart`          |
| React Native text | `textAlign: 'left'`     | `textAlign: 'auto'`     |

React Native differs from CSS on that last row and it catches people out: RN
does **not** accept `start` for `textAlign`. The direction-following value is
`auto`.

`@integr8/eslint-config` rejects every entry in the "wrong" column, in both
forms. It is a lint error, not a review comment.

### Checking a screen

- **Web and desktop** — tick "Preview right-to-left" in the preference bar. It
  flips `dir` on the document while the language stays English.
- **Mobile** — React Native decides direction natively at launch
  (`I18nManager.forceRTL`), so it follows the device language and needs an app
  restart to change. Set the phone or simulator to Arabic.

## Where tokens live on each client

Never `localStorage`, on any client. Any script on the page can read it, which
turns one cross-site scripting bug into every customer's data.

**Web** is the odd one out and deliberately so. A browser has no keychain, so
the refresh token never reaches JavaScript at all: it lives in an httpOnly
cookie set by a Next route handler, and the access token is a variable that
lasts as long as the tab. A reload costs one request to get a new one.

**Desktop and mobile** have real credential stores, so they use the shared
`SessionManager` with the refresh token on the device — the OS keychain via a
Rust command, and SecureStore respectively.

All three refresh through one latch, so six panels opening at once with an
expired token produce one refresh rather than six that invalidate each other's
rotated token.

## Running them

```bash
pnpm --filter @integr8/api dev       # the API first — everything else calls it
pnpm --filter @integr8/web dev       # http://localhost:3001
pnpm --filter @integr8/desktop dev   # http://localhost:3002, as a browser page
pnpm --filter @integr8/desktop tauri:dev   # the same bundle, as a window
pnpm --filter @integr8/mobile dev    # Metro; press i or a
```

### Building the Tauri shell

Needs a Rust toolchain. Two things to know before the first build:

- **A path containing a space breaks the GNU toolchain.** `windres` truncates
  the path at the space and the resource step fails. Either use the MSVC
  toolchain (`rustup default stable-x86_64-pc-windows-msvc`, which needs the
  Visual Studio Build Tools) or point Cargo somewhere without one:

  ```bash
  CARGO_TARGET_DIR=/c/integr8-rust-target pnpm --filter @integr8/desktop tauri:build
  ```

- **The crate builds `rlib` only.** Tauri's template also emits `staticlib` and
  `cdylib` for its iOS and Android targets, which this product does not use —
  its mobile app is Expo. Linking a `cdylib` this size with MinGW fails outright
  with "export ordinal too large".

### The updater

`pnpm --filter @integr8/desktop tauri signer generate` produced the keypair. The
**public** half is in `tauri.conf.json`; the **private** half is
`src-tauri/updater.key`, which is git-ignored and must go into a secret manager.
Whoever holds it can sign an update that every installed copy will accept and
run.

The endpoint in `tauri.conf.json` is a placeholder. P20 points it at a real
release feed.

### Mobile builds

Native builds go through EAS, configured in `eas.json`. They need an Expo
account and a project id — the one in `app.json` is a placeholder. Local
development needs neither: Metro bundles the JavaScript and Expo Go or a
development client runs it.

```bash
pnpm --filter @integr8/mobile build   # bundles ios and android through Metro
```

Not `--platform all`: that includes web, which would need `react-native-web`.
This product's web surface is the Next.js app.
