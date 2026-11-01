# Terms, privacy policy and data processing terms

Three public pages on the website, in English and Arabic, drafted on 31 October 2026 from what
the product actually does (pre-production audit, High 10). **They have not been reviewed by a
lawyer, and the operator's legal details are not filled in.** Both must happen before launch;
the checklist is at the end of this page.

| Page                  | Address                                       | For                                             |
| --------------------- | --------------------------------------------- | ----------------------------------------------- |
| Terms of service      | `https://app.integr8-media.com/legal/terms`   | The agreement between Integr8 and each company  |
| Privacy policy        | `https://app.integr8-media.com/legal/privacy` | Everybody whose data passes through the product |
| Data processing terms | `https://app.integr8-media.com/legal/dpa`     | Integr8 as the processor of each company's data |

**The app store listings use the privacy policy address**, `legalUrl('privacy')` in
`@integr8/core`. It is the operator's site rather than a deployment's, so it does not move when
a staging stack or a new server appears.

## Where the texts live

- **The words:** `packages/i18n/src/messages/legal.en.ts` and `legal.ar.ts`, merged into the
  catalogues as `legal.*`. Each section is a `title` and a `body`; in a body a blank line starts
  a paragraph and lines starting with `- ` are a list. The catalogue parity test covers them like
  every other string (keys, placeholders, untranslated values, brand names in Latin letters).
- **The operator, the date and the addresses:** `packages/core/src/legal.ts` — `LEGAL_OPERATOR`
  (registered name, address, commercial and tax registration, privacy email, hosting location),
  `LEGAL_LAST_UPDATED`, `LEGAL_REVIEWED`, `LEGAL_SITE_ORIGIN`, `legalPath` and `legalUrl`.
  Every operator detail is `null` today on purpose: none may be guessed. A page leaves a `null`
  out rather than print a placeholder, and `missingOperatorDetails()` lists what is still
  missing. Until `privacyEmail` is set, the pages give the contact page's address
  (`NEXT_PUBLIC_CONTACT_EMAIL`, falling back to `hello@integr8-media.com`).
- **The pages:** `apps/web/src/app/legal/{terms,privacy,dpa}/page.tsx`, drawn by
  `apps/web/src/components/legal-document.tsx`; the section order is in `apps/web/src/lib/legal.ts`,
  and a test fails if it and the English catalogue disagree. The browser title is set on the
  server in the reader's language (`legal-metadata.ts`).
- **The links:** the public footer (with a language switch, so either version can be read), the
  web sign-in page, the sign-up page, and the sign-up verify page, where the company is actually
  created and the line above the button says that creating it accepts the terms and the data
  processing terms. The desktop sign-in screen links to the published pages with new-window links
  (`apps/desktop/src/components/legal-links.tsx`), as the app opens every outside page. The phone
  app is handled separately.

While `LEGAL_REVIEWED` is `false`, each page shows a note under its date that the text awaits a
lawyer's review.

## What each covers

- **Terms of service:** who the parties are; that Integr8 sets companies up and keeps forms, job
  types, branding, document design and the e-invoicing switch; accounts; that the company owns
  its data; acceptable use; staff access through audited impersonation; fees, the fourteen-day
  trial, payment reminders and read-only after fourteen days' grace; suspension; availability;
  that payroll, ledger, tax and e-invoicing figures are management tools and e-invoicing goes only
  to the Tax Authority's test environment until Integr8 says otherwise; the assistant; ending,
  export and deletion; liability; changes; Egyptian law.
- **Privacy policy:** the two roles (the company is the controller of what it puts in, Integr8
  its processor; Integr8 the controller of its own account, billing, website and security data);
  what is collected, including exactly what the phone uses and when; why; cookies (functional
  only); every service provider and what it receives; storage outside Egypt; security measures;
  retention; rights under Law No. 151 of 2020 and how requests reach the company or Integr8;
  children; changes.
- **Data processing terms:** scope; the people and data concerned, purpose and duration;
  processing only on the company's instructions; staff confidentiality; security measures;
  sub-processors with thirty days' notice of a change; transfers outside Egypt; assistance;
  breach notification; information and audits; deletion at the end; the company's own duties.

## What the texts rest on

Each claim is true of the code on 31 October 2026. When one of these changes, the texts change
with it, `LEGAL_LAST_UPDATED` moves, and companies are told of a significant change thirty days
ahead (the terms promise that).

| Claim                                                       | Where it is true                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Each company's data kept apart by the database              | RLS on `app_current_tenant_id()`, `docs/database`                                      |
| Files private, links expire in minutes                      | `docs/media` ("Credentials": 15 minutes up, 5 down)                                    |
| ID, insurance and bank numbers encrypted, reveals recorded  | ADR-0010, `hr_employees` `*_sealed` (AES-256-GCM)                                      |
| Phone data encrypted, wiped on sign-out or revoked access   | `docs/mobile/README.md` (SQLCipher, wipe rules)                                        |
| Location only in use, at submission or a location question  | `apps/mobile/app.config.ts` (background location off), `docs/mobile/forms.md`          |
| Photos lose camera metadata, location included              | `docs/media` ("Compression on the device")                                             |
| No audio reaches Integr8                                    | `docs/ai` ADR-0002 D13                                                                 |
| Staff access audited, with a banner                         | `docs/platform` ("Impersonation"), platform audit log append-only                      |
| No automatic deletion of files by default                   | migration 0056, `docs/media` ("Retention")                                             |
| Assistant conversations deleted after the policy's window   | `retention_days` (default 30, `0044_ai_assistant`), `apps/api/src/ai/reconcile.ts`     |
| Deleted files restorable for thirty days                    | `MEDIA_RESTORE_DAYS`, `docs/media` ("Deleting")                                        |
| Closing: export, suspend, purge after seven days            | `docs/platform` ("Closing a company"), export downloadable 30 days (`EXPORT_TTL_DAYS`) |
| Sign-in accounts deleted with the company                   | `identity_deletions` (P36), unless the person belongs to another company               |
| Nightly backups kept fourteen days                          | setup guide Stage 9 B, `deploy/vps/backup-postgres.sh`                                 |
| Sentry gets no personal details                             | `sendDefaultPii: false` / `dataCollection` off in the API, web, desktop and phone      |
| Mapbox, Expo, Resend, Stripe, R2 in production              | `apps/api/src/config.ts` refuses the stand-ins in production                           |
| AI: questions to the provider, company data only if allowed | ADR-0001 D5 (`company_data_to_provider`, platform-only, default off), ADR-0002         |
| E-invoicing only to the test environment                    | `ETA_ALLOW_PRODUCTION=false`, `docs/e-invoicing/RUNBOOK.md`                            |
| Trial and grace of fourteen days                            | `BILLING_TRIAL_DAYS`, `BILLING_GRACE_DAYS` defaults                                    |

Deliberately left out: GitHub, which builds each company's branded apps, receives the company's
name, logo and colours but no personal data; and there is no cookie banner because there are no
cookies beyond the ones the site needs to work.

## Before launch

1. **An Egyptian lawyer reviews all three texts, in both languages**, and decides which language
   prevails if they differ. The review should cover at least:
   - the obligations of Law No. 151 of 2020 and its executive regulations that sit outside these
     texts: licences or registration with the Personal Data Protection Center for Integr8 as a
     processor and controller, a data protection officer, the licence or permit for transfers
     outside Egypt, and the deadlines for notifying breaches and answering individuals' requests
     (the texts deliberately name no deadline the law does not fix for them);
   - the commercial choices in the terms, which are the owner's to confirm: Integr8 ending the
     agreement on thirty days' notice, thirty days' notice of significant changes and of new
     sub-processors, liability capped at twelve months' fees, the courts of Cairo, and an audit at
     most once a year.
2. **Fill in `LEGAL_OPERATOR`** in `packages/core/src/legal.ts`: the registered name, registered
   address, commercial registration, tax registration, a privacy email address that is read, and
   the hosting location (the Oracle Cloud home region chosen in setup guide Stage 0).
   `missingOperatorDetails()` must return nothing; its test in `legal.test.ts` pins today's list,
   so update the test with it.
3. **Check the provider list against the deployment**: the AI provider actually configured
   (`AI_PROVIDER`), Mapbox for geocoding only (the apps draw no maps since 2026-10-31; the
   site screens link to Google Maps, opened by the person), and how long Oracle keeps copies of
   the server's disk under the backup
   policy chosen, then sign each provider's own data processing agreement.
4. **Companies Integr8 sets up never see the sign-up page**, so they accept the terms and the
   data processing terms in their signed order; the order should link to both.
5. Set `LEGAL_REVIEWED` to `true` and `LEGAL_LAST_UPDATED` to the day the reviewed texts go live.
