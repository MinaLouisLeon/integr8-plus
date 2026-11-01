# The Integr8 Media look

Integr8 Plus is one of Integr8 Media's products, so everything that is
**Integr8's own** wears the company site's look (www.integr8-media.com, Next 16 +
Tailwind 4; source `MinaLouisLeon/integr8-media-website`). Everything that is **a
customer's** does not.

| Wears the Integr8 Media look                                                    | Keeps its own look                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Public pages: home, features, pricing, help, contact, download, sign-up, legal  | A company's workspace `(app)/…`: the company's brand, light or dark                                 |
| Sign-in, accept invitation, the staff sign-in                                   | Public document and quote views (`/d/…`, `/q/…`): the company's                                     |
| The staff dashboard `/platform` (layout, shell, every page through the tokens)  | A company's own desktop and phone apps                                                              |
| The staff desktop app's frame: side menu, top bar, sign-in (`staff` build only) | The screens inside the staff desktop frame (staff set a company up there and need to see its brand) |

Screenshots of every page, desktop (1440) and phone (390), English and Arabic,
are in [`screenshots/`](./screenshots/).

## Tokens

All in `packages/tokens/src/site.ts`, generated into `theme.css` by
`pnpm --filter @integr8/tokens css` (the build runs it):

| Token    | Value                   | Tailwind utility                         |
| -------- | ----------------------- | ---------------------------------------- |
| `bg`     | `#07060b`               | `bg-site-bg`                             |
| `bgSoft` | `#100e18`               | `bg-site-soft`                           |
| `fg`     | `#f4f2ff`               | `text-site-fg`                           |
| `muted`  | `#9a96b0`               | `text-site-muted`                        |
| `line`   | `rgba(255,255,255,.08)` | `border-site-line`                       |
| `violet` | `#7c5cff`               | `bg-violet`, `text-violet`               |
| `cyan`   | `#22d3ee`               | `bg-cyan`                                |
| `lime`   | `#c6ff3d` (the accent)  | `bg-lime`, `text-lime`                   |
| `pink`   | `#ff4fd8`               | `bg-pink`                                |
| gradient | violet → cyan → lime    | `.text-gradient`, `var(--site-gradient)` |

The look is switched on by an attribute: **`data-look="integr8"`** on the element
that wraps the pages (the `MarketingShell`, the `AuthShell` added by the sign-in
layouts, the `/platform` layout, the desktop `integr8Look()` helper). Inside it the
**semantic tokens are redefined** (`--colour-background` is the site's black,
`--colour-accent` is lime with near-black on it, the shell is dark), so the shared
components — `Button`, `Field`, tables, the dashboard shell — follow without a
second set of classes. Buttons become pills there through Tailwind's
`in-data-[look=integr8]:` variant in `components/ui.tsx`. The company workspace never
carries the attribute, so it keeps the company's accent, menu colour and theme.

## Fonts

Self-hosted: nothing is fetched from a font service. `packages/tokens/fonts.css`
imports the exact-pinned `@fontsource` packages, and each app imports that file once
(`apps/web/src/app/layout.tsx`, `apps/desktop/src/main.tsx`); the bundler serves the
files with the app. They are split by `unicode-range`, so a page downloads only the
scripts it draws, and the workspace, which names none of the families, downloads none.

| Role            | English                      | Arabic               |
| --------------- | ---------------------------- | -------------------- |
| Headings        | Unbounded (`font-display`)   | Alexandria           |
| Text            | Inter (`font-sans`)          | IBM Plex Sans Arabic |
| Labels, numbers | JetBrains Mono (`font-mono`) | IBM Plex Sans Arabic |

Arabic pages swap the stacks with `[data-look='integr8']:lang(ar)`, so nothing on a
page has to know which language it is in. The logo is always drawn left to right in
Unbounded and Inter: it is a mark, not a sentence.

## The pieces

In `apps/web/src/components/`:

- `marketing-shell.tsx` — the public frame: a floating rounded nav that slides away
  while reading down and returns on the way up, a gradient scroll-progress line, the
  language switch, the lime pill, a full-screen menu on phones, the footer;
  `PageIntro`, `pillClass`, `GetStartedLink`, `LanguageToggle`, `AuthShell`,
  `INTEGR8_MEDIA_URL` (linked from the header and the footer as "By Integr8 Media").
- `site/logo.tsx` — "Integr" + a lime "8" that turns on hover + spaced "PLUS".
- `site/motion.tsx` — `Magnetic` (hover pull, mouse only), `RevealText` (words
  rising out of a mask when scrolled into view), `ScrambleText` (decoding from
  random glyphs; Arabic text scrambles with Arabic letters), `Eyebrow` (the label
  with the pulsing lime dot), `Grain`. Small hooks and CSS, no animation library.
- `app/globals.css` — the effects that are not tokens: `.text-gradient`,
  `.text-outline`, the grain, the scroll line, the reveal mask, the marquee, the
  phone menu. Directional ones (scroll line, gradient, marquee, menu circle) are
  mirrored for `[dir='rtl']`.

Deliberately left out from the company site: the preloader, the custom cursor and
the playground. They belong to a studio's showcase, not a product's front door.

## Reduced motion

Every effect stands still when the system asks for reduced motion: `Magnetic` and
`ScrambleText` do nothing (`useReducedMotion`), revealed words are simply there, the
grain, the turning 8 and the marquee stop, and the global rule in `globals.css` cuts
any remaining transition to nothing.

## English first

The language is **English unless the person chose Arabic**. The choice is the
`integr8_locale` cookie, set by the language switch on the public pages and by the
language menu in the workspace and the dashboard, and remembered. The browser's
`Accept-Language` is not consulted (`apps/web/src/lib/preferences.ts`). The desktop
app already worked this way (`localStorage`, English by default). The phone app still
follows the device's language; that is outside this change.

## Words

The public site's words are the `site.*` block of `@integr8/i18n`, in its own files
(`packages/i18n/src/messages/site.en.ts` and `site.ar.ts`); the catalogue parity test
covers them, and `apps/web/src/lib/site-content.test.ts` checks the fifteen features
the page lists all have words in both languages. Write them from what the product
does today, without superlatives or invented numbers.
