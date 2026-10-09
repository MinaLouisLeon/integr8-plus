# Company builds

Each company gets its own phone app: its name, icon and colours, its website on the first
screen, and a sign-in that accepts only its own people. It is the same code as the generic
Integr8 Plus app; what differs is one file CI writes before `eas build`.

## `company.json`

`apps/mobile/company.json` is git-ignored. CI writes it from the public brand endpoint
(`GET /v1/public/companies/{slug}/brand`, no session), and downloads the app icon from
`appIconPath` to `apps/mobile/company/icon.png` (also ignored). The file is exactly the endpoint's
answer; `company.example.json` is a committed sample.

| Field                     | Meaning                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `slug`                    | The company's slug. Required; lower-case letters, digits and hyphens.    |
| `name`                    | The company's name. Required. Becomes the app's name.                    |
| `websiteUrl`              | Shown on the welcome screen and behind the Website buttons. May be null. |
| `brandColour`             | `#rrggbb` accent. May be null.                                           |
| `shellColour`             | `#rrggbb` header and icon background. May be null.                       |
| `defaultTheme`            | `light`, `dark` or `system` (follow the phone).                          |
| `logoPath`, `appIconPath` | Relative to the API base URL; they redirect to the image. May be null.   |

Without the file, `app.config.ts` produces the generic app exactly as `app.json` used to.

## Identifiers

`app.config.ts` derives everything from the slug through `companyIdentifiers()` in
`src/lib/company-config.ts` (tested in `company-config.test.ts`):

| Setting                        | Generic app               | Company `acme-2`                                                                                                             |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`                         | Integr8 Plus              | the company's name                                                                                                           |
| `slug`, `scheme`               | `integr8-plus`, `integr8` | `integr8-acme-2`                                                                                                             |
| `ios.bundleIdentifier`         | `com.integr8.plus`        | `com.integr8.plus.acme-2` (hyphens are legal on iOS)                                                                         |
| `android.package`              | `com.integr8.plus`        | `com.integr8.plus.acme_2`: hyphens become underscores, and a slug starting with a digit gets a `c` in front (`7up` → `c7up`) |
| `icon`, `android.adaptiveIcon` | none                      | `./company/icon.png` when CI downloaded it                                                                                   |
| icon and splash background     | none                      | `shellColour` ?? `brandColour` ?? `#ffffff`                                                                                  |
| `extra.company`                | absent                    | the whole `company.json`, which the app reads as `COMPANY`                                                                   |

The EAS project id, `updates.url`, `runtimeVersion` and every plugin stay the same for all
companies. EAS keeps credentials per app identifier inside the one project, and CI chooses the
update channel with `eas build --channel production-<slug>`.

## The brand on the phone

`BrandProvider` (`src/components/brand.tsx`) takes the brand from the freshest place that knows
it (`resolveBrandSource()` in `src/lib/brand-source.ts`):

1. **The signed-in identity.** The `meta` table, written by every download: name, slug, brand
   and shell colours, default theme, website, logo and app icon ids.
2. **The cached public brand.** On launch a company build fetches the brand endpoint (sending
   `x-client-app: mobile` and `x-client-version`) and keeps the answer in `brand.json` in the
   document directory (`src/lib/brand-cache.ts`). If the request fails, the app keeps the brand
   it already has.
3. **The build.** `COMPANY`, from `extra.company`, so even a first launch without signal is
   branded.

`useTheme()` follows the company's `defaultTheme` (`system` follows the phone), and merges the
accent tokens and, when there is a shell colour, the shell tokens.

## The welcome screen

When nobody is signed in and the build has a company, `app/index.tsx` and the signed-out handler
in `app/_layout.tsx` go to `/welcome` rather than `/sign-in`. It shows a slim header in the shell
colour (falling back to the accent, then the surface colour) with the logo, the name, and Login at
the end of the row. Under the header is the company's website in a `WebView`, with a loading
indicator and a Retry when the page fails or there is no connection. A link that leaves the
site's origin opens in the system browser. A company without a website gets a branded welcome
with Login instead. Once someone is signed in, Home and Settings show a Website button when there
is a website.

## The sign-in lock

In a company build, sign-in sends `companySlug`. The API answers `403 wrong_company` for an
account from another company, and the screen says so by name (`auth.wrongCompany`). As a second
check, `verifySignedInCompany()` (`src/lib/company-guard.ts`) reads `/v1/me` right after
sign-in and signs out if the slug differs. Nothing is downloaded before that check. The screen
also has Back to the welcome screen.
