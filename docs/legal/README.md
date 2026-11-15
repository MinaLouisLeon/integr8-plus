# The legal pages

Three public pages, in English and Arabic, drafted from what the product does.
**No lawyer has reviewed them, and the operator's legal details are not filled
in.** Both must happen before launch.

| Page                  | Address                                       | For                                             |
| --------------------- | --------------------------------------------- | ----------------------------------------------- |
| Terms of service      | `https://app.integr8-media.com/legal/terms`   | The agreement between Integr8 and each company  |
| Privacy policy        | `https://app.integr8-media.com/legal/privacy` | Everybody whose data passes through the product |
| Data processing terms | `https://app.integr8-media.com/legal/dpa`     | Integr8 as the processor of each company's data |

The app store listings use the privacy policy's address (`legalUrl('privacy')`
in `@integr8/core`).

## Where they live

- **The words:** `packages/i18n/src/messages/legal.en.ts` and `legal.ar.ts`
  (`legal.*`; each section a `title` and a `body`, a blank line between
  paragraphs, `- ` for list items), checked by the catalogue parity test.
- **The operator, date and addresses:** `packages/core/src/legal.ts`:
  `LEGAL_OPERATOR` (registered name, address, commercial and tax registration,
  privacy email, hosting location; all `null` until known, never guessed),
  `LEGAL_LAST_UPDATED`, `LEGAL_REVIEWED`, `legalUrl`. A page leaves a `null` out;
  `missingOperatorDetails()` lists what is missing; until `privacyEmail` is set the
  contact address is used (`NEXT_PUBLIC_CONTACT_EMAIL`). While `LEGAL_REVIEWED`
  is `false` each page says it awaits review.
- **The pages:** `apps/web/src/app/legal/{terms,privacy,dpa}/page.tsx`, drawn by
  `components/legal-document.tsx`, section order in `apps/web/src/lib/legal.ts`.
- **The links:** the public footer, the web sign-in and sign-up pages (creating
  a company accepts the terms and the data processing terms), and the desktop
  sign-in screen (`apps/desktop/src/components/legal-links.tsx`).

## What they cover

- **Terms:** the parties; that Integr8 sets companies up and keeps their forms,
  job types, branding, document design and the e-invoicing switch; accounts; the
  company owns its data; acceptable use; staff access through audited
  impersonation; fees, trial, reminders and suspension; availability; payroll,
  ledger, tax and e-invoicing figures as management tools (e-invoicing only to the
  Tax Authority's test environment until Integr8 says otherwise); the assistant;
  ending, export and deletion; liability; changes; Egyptian law.
- **Privacy:** the company as controller of what it puts in and Integr8 as its
  processor; Integr8 as controller of its own account, billing, website and
  security data; what is collected (including what the phone uses and when);
  functional cookies only; every service provider; storage outside Egypt;
  security; retention; rights under Law No. 151 of 2020; children; changes.
- **Data processing terms:** scope, purpose and duration; processing on the
  company's instructions; confidentiality; security; sub-processors with thirty
  days' notice; transfers; assistance; breach notification; audits; deletion at
  the end.

Each claim must stay true of the code. When one changes, the texts change with
it, `LEGAL_LAST_UPDATED` moves, and companies are told of a significant change
thirty days ahead. Claims to recheck with the lawyer against 2.0.0: billing is
invoiced by Integr8 only (P42 removed card payments, trials and automatic
read-only), the office works in desktop apps with no web workspace, files have no retention window by default, the assistant is off
until switched on, and test companies send no mail.

## Before launch

1. A lawyer qualified in Egypt reviews all three texts in both languages.
2. Fill `LEGAL_OPERATOR` and `LEGAL_LAST_UPDATED`; set `LEGAL_REVIEWED = true`.
3. Confirm the list of service providers (hosting, R2, Resend, Expo, Sentry,
   Mapbox, the AI provider when on) and where each keeps data.
