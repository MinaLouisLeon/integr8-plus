# Integr8 Plus Setup Checklist

_Integr8 Plus 1.2.2 · everything you do, in order · Oracle Cloud edition_

**From zero to a running deployment, in order**

Stage 0 creates every account and collects every key and secret before anything is installed. Stages 1 to 5 put the stack on Oracle Cloud's Always Free ARM machine with your domain. Stage 6 has GitHub build the staff desktop app. Stage 7 walks a customer's day through all of it, and Stage 8 is how every company gets desktop installers and a phone app of its own. Stage 9 is the production switch. Nothing in any stage needs something from a later stage, and nothing is ever built on your laptop.

> [!WARNING]
> **Destroying the Oracle machine and building a new one?** Start at [Stage 13](#stage-13--destroy-the-oracle-machine-or-empty-it-and-keep-it): it says what to save before the machine goes, which stages to redo on the new one, and which of Stage 0's accounts and keys carry over unchanged.

> [!NOTE]
> **New: the AI assistant, with or without AI.** It is off until you turn it on. Each company answers either with an **AI model** from the one provider the server uses (OpenAI, Groq, Google Gemini or Anthropic) or from the **help library**, with no AI, no key and no cost; you choose per plan or per company. The steps are spread through the stages where they belong: [Stage 0, Part M](#m-the-ai-assistant-a-provider-or-none) (choosing a provider, or none, and its key), [Stage 3](#stage-3--the-env-file-filled-once-from-the-key-sheet) (the server's settings), [Stage 5](#the-ai-assistant-is-the-server-ready-and-what-does-each-plan-allow) (what each plan allows, and where answers come from), [Stage 7](#the-ai-assistant-for-this-company) (a company's apps, and each person's percentage share) and [Stage 11](#j-this-update-bringing-the-ai-assistant-to-a-machine-that-runs-110) (getting it onto a running machine and into the apps). AI answers need a **share** per person; help-library answers do not. **Voice** needs nothing on the server: members can speak a question (AI-model companies) and have answers read aloud (every company), with the device's own speech tools; the steps are in Stage 7 (try it) and Stage 8 (the phone apps need a rebuild).

> [!NOTE]
> **New: PDF documents.** Integr8 staff design PDF templates for a company's forms in the staff desktop app. The company turns a submission into a PDF with a QR code, keeps it in its own storage, and finds it again in a **Documents** register; its own website can look documents up with a **website key**. Nothing to set up on the server: the image brings what it needs. The steps: [Stage 3](#stage-3--the-env-file-filled-once-from-the-key-sheet) (one line to check), [Stage 7](#pdf-documents-for-this-company) (switching it on, a template, a first PDF, a website key) and [Stage 11](#k-this-update-pdf-documents) (bringing it to a running machine). The operator's details are in `docs/documents/RUNBOOK.md`.

> [!NOTE]
> **New in `main`: e-invoicing for the Egyptian Tax Authority (ETA).** A company prepares an ETA document from an issued invoice, signs it with its own token on the accountant's computer, and sends it; Integr8 follows its status until the ETA says it is valid. Each company enters its own ETA credentials, which are locked on the server. It is **not ready for real tax documents**: nothing has been sent to the ETA yet, and the desktop app cannot sign until a driver for the company's token is added. It reached `main` in pull request 109; its desktop installers come from builds after pull request 110. The steps: [Stage 0, Part B](#b-secrets-you-generate-yourself) (one more key), [Stage 3](#stage-3--the-env-file-filled-once-from-the-key-sheet) (where it goes), [Stage 7](#e-invoicing-eta-for-this-company) (setting a company up on the ETA's test system) and [Stage 11](#l-this-update-e-invoicing) (bringing it to a running machine). The operator's details are in `docs/e-invoicing/RUNBOOK.md`.

> [!NOTE]
> **New: sign-in runs on your own machine.** Passwords and sign-in codes are kept by a Supabase Auth container beside the API, so there is no Supabase account or project any more. A person who forgets their password signs in with a 6-digit code sent by email and sets a new one under **Change password**. The steps: [Stage 0, Part B](#b-secrets-you-generate-yourself) (three more secrets), [Stage 3](#stage-3--the-env-file-filled-once-from-the-key-sheet) (where they go), [Stage 4](#stage-4--start-the-stack) (the `auth` container is healthy) and [Stage 11, part Q](#q-self-hosted-sign-in-included-in-v122) (bringing it to a running machine). The details are in `docs/auth/self-hosted-auth.md`.

> [!NOTE]
> **New: a demo company full of test data.** One command on the machine creates a company with something in every section (customers, jobs, stock, sales, finance, HR, the ledger and the rest) and nine people to sign in as, one per role. The steps are in [Stage 14](#stage-14--a-demo-company-full-of-test-data).

> [!NOTE]
> **New: backups that leave the machine, and a restore drill.** The nightly backup can copy each dump to an encrypted R2 bucket and tell a heartbeat monitor how every night went, and one command rehearses a restore in a throwaway container without touching the live database. The steps are in [Stage 9, part B](#b-the-database-and-backups), and in [Stage 11, part R](#r-backups-off-the-machine-and-the-restore-drill-included-in-v122) for a machine that is already running. Rolling back to an earlier release now starts it on the newer database instead of stopping at its migration step ([Stage 11, part I](#i-if-something-goes-wrong-rolling-back)).

> [!TIP]
> GitHub shows the boxes below but does not let you tick them in a file. To track your progress, copy a stage into an issue (checkboxes there can be ticked), or open the interactive page described in the [last section](#about-this-page).

## Contents

- [Stage 0 — Accounts, tools and every key, before anything is installed](#stage-0--accounts-tools-and-every-key-before-anything-is-installed)
- [Stage 1 — The Oracle machine](#stage-1--the-oracle-machine)
- [Stage 2 — Two names, and Caddy](#stage-2--two-names-and-caddy)
- [Stage 3 — The env file, filled once from the key sheet](#stage-3--the-env-file-filled-once-from-the-key-sheet)
- [Stage 4 — Start the stack](#stage-4--start-the-stack)
- [Stage 5 — The super admin, your staff, the plans, and a first look](#stage-5--the-super-admin-your-staff-the-plans-and-a-first-look)
- [Stage 6 — The staff desktop app, built by GitHub](#stage-6--the-staff-desktop-app-built-by-github)
- [Stage 7 — A customer's day, end to end](#stage-7--a-customers-day-end-to-end)
- [Stage 8 — Apps built for each company](#stage-8--apps-built-for-each-company)
- [Stage 9 — Go live: the production switch](#stage-9--go-live-the-production-switch)
- [Stage 10 — A test box at home on Ubuntu with Arcane](#stage-10--a-test-box-at-home-on-ubuntu-with-arcane)
- [Stage 11 — Updating to a new version](#stage-11--updating-to-a-new-version)
- [Stage 12 — Wipe the machine and start fresh](#stage-12--wipe-the-machine-and-start-fresh)
- [Stage 13 — Destroy the Oracle machine, or empty it and keep it](#stage-13--destroy-the-oracle-machine-or-empty-it-and-keep-it)
- [Stage 14 — A demo company full of test data](#stage-14--a-demo-company-full-of-test-data)

---

## Stage 0 — Accounts, tools and every key, before anything is installed

_about half a day, plus two DNS waits_

Everything the stack needs from the outside world is created and written down here, once, in the order the services depend on each other. When this stage is done you hold a **key sheet** (the table at the end of this stage) with every value filled in, and the rest of the guide only ever copies from it. Keep a password manager open throughout: several services show a secret exactly once.

> [!NOTE]
> **Two modes.** The API runs in `staging` mode first, where it tolerates a missing service, and is switched to `production` mode in Stage 9, where it refuses to start unless every service below is real. Collecting everything now means that switch is one line.

### A. Your Windows 11 laptop, one-time setup

The laptop generates the signing keys, connects to the server over SSH and edits one file on GitHub. It never builds anything. Commands marked `# laptop` are typed into **PowerShell** (open the **Terminal** app from the Start menu); commands marked `# machine` are typed into the SSH session once the server exists, where the server's own Linux shell runs them. Never mix them up.

- [ ] **Allow PowerShell to run scripts**, once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`.
- [ ] **Install Git and Node** with the commands below (Node LTS is 22 or newer). Close and reopen the Terminal afterwards so the new programs are on the path.

```powershell
# laptop (PowerShell)
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
# close this window, open a new Terminal, then:
git --version
node --version          # v22 or v24
npm install -g pnpm@latest-10
pnpm --version          # 10.x
git config --global core.autocrlf false
```

- [ ] **Get the repository** (it is public) and install its packages; the key generator in Part B needs them:

```powershell
# laptop (PowerShell)
cd ~\Documents
git clone https://github.com/MinaLouisLeon/integr8-plus.git
cd integr8-plus
pnpm install
```

- [ ] **Make an SSH key** for the server: `ssh-keygen -t ed25519`, Enter at every prompt. Then `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard` puts the public half on the clipboard; Stage 1 pastes it into Oracle's form.

> [!NOTE]
> The `autocrlf` line turns off Windows line-ending conversion, so files look the same on the laptop as on the server. Prefer Linux commands? `wsl --install` in an administrator PowerShell gives you Ubuntu inside Windows and every `# laptop` box works there with the Linux commands from the repository's docs.

### B. Secrets you generate yourself

- [ ] **Three database passwords.** Run the line below three times; each gives 48 letters and digits, no symbols (each password also has to sit inside a web-style address). Write them in the key sheet as `POSTGRES_PASSWORD`, `INTEGR8_APP_PASSWORD`, `INTEGR8_AUTH_PASSWORD`.
- [ ] **The build token (optional until you build company apps).** Run the same line a fourth time. Key sheet: `BUILD_TOKEN`. When you use it, put the same value in the machine's env file (Stage 3) and a GitHub secret (Part K). It lets GitHub ask the API which companies to build apps for (Stage 8); without it, the API starts normally but that company-list lookup is unavailable.

```powershell
# laptop (PowerShell)
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

- [ ] **The signing keys and the sign-in secrets.** The generator writes seven lines to `keys.txt` and opens it in Notepad, because the lines are long and copying them from a wrapped terminal breaks them. Put all seven into the key sheet and your password manager, then delete the file: the four signing keys (`AUTH_SIGNING_KEY_ID`, `AUTH_SIGNING_KEY`, `AUTH_VERIFICATION_KEYS`, `PLATFORM_SECRET_KEY`) and the three the sign-in server needs (`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_DB_PASSWORD`). The last three belong together: the service role key is signed with the JWT secret, so if one is ever made again, all three are.

```powershell
# laptop (PowerShell), in the repository folder
cd ~\Documents\integr8-plus
pnpm --silent --filter @integr8/auth keygen | Select-String '^[A-Z_]+=' | ForEach-Object Line | Set-Content -Encoding ascii keys.txt
notepad keys.txt
# after copying the seven lines into your password manager:
Remove-Item keys.txt
```

> [!WARNING]
> `PLATFORM_SECRET_KEY` encrypts every super admin's authenticator secret. If it is ever changed, every super admin sets up their authenticator again. Keep it.

- [ ] **The HR data key (optional until you use sensitive HR fields).** The HR module encrypts employees' national ID, social insurance and bank account numbers with this key: 32 random bytes written as base64 (44 characters ending in `=`). Key sheet: `HR_DATA_KEY`. Without it the API starts normally, but those three values cannot be stored, shown or exported ("HR key missing").

```powershell
# laptop (PowerShell)
$k = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k); [Convert]::ToBase64String($k)
```

> [!WARNING]
> `HR_DATA_KEY` belongs with the database backups: a backup restored without the key it was written with has those employee numbers unreadable for ever. Never generate a new one for an existing database; carry the same value to every new machine.

- [ ] **The e-invoicing key.** The e-invoicing module locks each company's Egyptian Tax Authority (ETA) client ID and secret with this key: 32 random bytes written as base64, made with the same command as the HR data key (run it again; never reuse that value). Key sheet: `ETA_CREDENTIALS_KEY`. Without it companies cannot save their ETA credentials ("ETA key missing"); nothing else is affected, and the server starts without it. Optional while e-invoicing is off for every company: make it before you switch it on for the first one.

> [!WARNING]
> `ETA_CREDENTIALS_KEY` also belongs with the database backups. Restored without it, every company's saved ETA credentials are unreadable and each company enters them again. E-invoicing is not ready to send real tax documents yet: leave `ETA_ALLOW_PRODUCTION=false` (see `docs/e-invoicing/RUNBOOK.md`).

### C. Oracle Cloud account

- [ ] **Sign up** at `cloud.oracle.com` → "Start for free", with your real name and address exactly as on your card (mismatches are the usual reason a signup is refused). Oracle places a small verification hold and releases it. Always Free resources are free for ever; a card is needed only to verify you.
- [ ] **Choose the home region carefully.** It cannot be changed, and the free machine must live there. Pick the region nearest your customers; the biggest regions (Frankfurt, London, Ashburn, Phoenix) have the most "out of capacity" errors, and a quieter nearby one often works first time.
- [ ] **Wait for the account to be ready** (minutes to a day; an email tells you). The machine itself is Stage 1.

### D. Domain and Cloudflare

- [ ] **Own the domain.** You have `integr8-media.com`. The product uses `app.integr8-media.com` for the web app and `api.integr8-media.com` for the API; both names are free sub-names of the domain.
- [ ] **Create a Cloudflare account** at `dash.cloudflare.com` → **Add a domain** → type the domain, **Free** plan, skip the record import. Cloudflare shows two **nameservers** (like `ada.ns.cloudflare.com`): the servers that will keep this domain's phone book, so that a name becomes an IP address.
- [ ] **Point the registrar at Cloudflare.** At the registrar where the domain was bought: the domain's settings → **Nameservers** → custom → replace what is there with Cloudflare's two. Cloudflare emails you when it sees the change; up to an hour, occasionally longer. Carry on with E to J meanwhile; F needs this to have finished.
- [ ] **Enable R2** (Cloudflare's file storage; the product makes one bucket per company): dashboard → **R2 Object Storage** → Get started. Cloudflare asks for a payment method even for the free 10 GB; nothing is charged below it.
- [ ] **Copy your Account ID** from the R2 overview page (right-hand side; also in the dashboard URL after `dash.cloudflare.com/`). Key sheet: `CLOUDFLARE_ACCOUNT_ID`.
- [ ] **Create an R2 API token**: R2 → **Manage R2 API Tokens** → Create API token, name `integr8`, permission **Admin Read & Write** (it creates and deletes buckets), all buckets, no TTL. Copy the **Access Key ID** (`R2_ACCESS_KEY_ID`) and the **Secret Access Key** (`R2_SECRET_ACCESS_KEY`); the secret is shown once. Do not create buckets by hand: the worker creates `integr8-production-<company id>` for each company with the right rules.

### E. Sign-in, on your own machine

Passwords and the 6-digit sign-in codes are kept by a Supabase Auth container that runs beside the API on your own machine (Stage 4). There is no Supabase account or project to create, and it sends no email itself: the API sends each code through Resend (Part F), in the person's language.

- [ ] **Nothing to sign up for.** The three secrets it needs came from the key generator in Part B. Check that `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_AUTH_DB_PASSWORD` are in the key sheet.

### F. Resend, for email

Invitations, sign-in codes and payment reminders are sent by the product through Resend. This part needs D's nameserver change to have finished, because Resend verifies the domain through DNS records you add in Cloudflare.

- [ ] **Create an account** at `resend.com`. Domains → Add Domain → `integr8-media.com`. Resend shows DNS records (an MX, a TXT for SPF, a DKIM record). Add each in Cloudflare → DNS → Records exactly as shown, then click Verify in Resend; minutes to an hour.
- [ ] **Create an API key**: API Keys → Create → name `integr8-production`, permission **Sending access**, restricted to your domain. Copy it (`re_…`, shown once). Key sheet: `RESEND_API_KEY`, and `EMAIL_FROM` = `Integr8 Plus <info@integr8-media.com>`.

### G. Stripe, for companies that pay in the app

Each company is either invoiced by you or pays in the app with a card. Stripe is for the second kind. Start in **test mode**: its own keys, its own customers, and the card `4242 4242 4242 4242` pays every time. Stage 9 repeats this in live mode.

- [ ] **Create an account** at `stripe.com`; make sure the **test mode** toggle (top right) is on for everything below.
- [ ] **Secret key**: Developers → **API keys** → Secret key, `sk_test_…`. Key sheet: `STRIPE_SECRET_KEY`.
- [ ] **Three products**: Product catalog → Add product → **Starter**, **Standard**, **Enterprise**, each with a recurring **monthly** price (yearly optional). Open each price and copy its ID (`price_…`). Key sheet: the price IDs; they go into the platform dashboard in Stage 5, not the env file.
- [ ] **Webhook**: Developers → **Webhooks** → Add endpoint → URL `https://api.integr8-media.com/v1/billing/webhook` (the API does not exist yet; Stripe accepts the address anyway). Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`. Reveal the **Signing secret** (`whsec_…`). Key sheet: `STRIPE_WEBHOOK_SECRET`.

### H. Mapbox, for site addresses on a map

- [ ] **Create an account** at `mapbox.com` (100,000 geocodes a month free). Account → **Access tokens** → Create a token, name `integr8`, default public scopes. Copy it (`pk.…`). Key sheet: `MAPBOX_ACCESS_TOKEN`. Used server-side only.

### I. Sentry, for errors

- [ ] **Create an account** at `sentry.io` and four projects: a **Node.js** project (API and worker), a **Next.js** project (web app), a **React** project (desktop app) and a **React Native** project (phone app). Each project → Settings → **Client Keys (DSN)**; a DSN looks like `https://abc@o123.ingest.sentry.io/456` and is safe to expose. Key sheet: `SENTRY_DSN` (Node), `WEB_SENTRY_DSN` and `WEB_PUBLIC_SENTRY_DSN` (both the Next.js DSN), `DESKTOP_PUBLIC_SENTRY_DSN` (React), `EXPO_PUBLIC_SENTRY_DSN` (React Native).

### J. Expo, for the phone app

The phone app is built by Expo's build service, told to start by GitHub. Nothing Expo-related is installed on your laptop.

- [ ] **Create the account** at `expo.dev` → Sign up, with `info@integr8-media.com`; choose a username (`integr8` or similar) and confirm the email. The free plan allows a limited number of builds a month and one at a time, enough for one test company. Every company gets its own phone build at every release (Stage 8), so with a few companies the Production plan is the next step; nothing else changes.
- [ ] **Create the project**: dashboard → **Projects** → **Create a Project**, named exactly `integr8-plus` (it must match the `slug` in `apps/mobile/app.config.ts`). One Expo project holds every company's app: Expo keeps the signing keys per app identifier, and each company's build has its own. On the project's page copy its **Project ID**. Key sheet: Expo Project ID.
- [ ] **Access token**: your avatar → **Account settings** → **Access tokens** → Create token, named `github-actions`; shown once. Key sheet: `EXPO_TOKEN`.
- [ ] **Firebase, for notifications on Android.** Android phones receive notifications through Google's Firebase Cloud Messaging, which needs a Firebase project. At `console.firebase.google.com`, signed in with the Google account that will own it, **Add project** `integr8-plus` (Google Analytics is not needed). Project settings → General → **Add app** → Android, package `com.integr8.plus`, then **Download google-services.json**. Project settings → **Service accounts** → **Generate new private key**: the FCM key Expo sends notifications with, a JSON file shown once. Key sheet: both files, kept in the password manager. Each company's app joins the same project in Stage 8. iOS needs nothing here: Expo makes the Apple push key with the first iOS build.

### K. GitHub: the repository's settings

GitHub builds the server images, the desktop installers and (through Expo) the phone app. Three things to do, all on the website. The repository is public, so the build minutes are free, including macOS.

- [ ] **Nothing to merge.** All changes this guide previously asked for are in `main`, now at version **1.2.2**. Its release builds include the CRM/ERP suite, AI assistant, PDF documents, ETA e-invoicing, the company website data API, the schedule, skills and certificates, contracts, maintenance and deadlines, and self-hosted sign-in, plus the API image/config fixes from v1.1.1 and the staff-app refresh button from v1.1.2. A new install sets all of it up in the stages below; a server on an older version also needs the three sign-in secrets of Stage 11 part Q. Use `main` as it is; a new install continues at Stage 3, and an older server is updated through Stage 11.
- [ ] **Put the Expo Project ID into the repository.** Open `apps/mobile/app.config.ts` on GitHub, click the pencil, replace the placeholder id in **both** places shown below (the file is TypeScript now, the two values look the same), choose "Create a new branch and start a pull request", and merge it to `main`.

```text
"extra": {
  "eas": {
    "projectId": "00000000-0000-0000-0000-000000000000"      ← your Project ID
  }
},
"runtimeVersion": { "policy": "fingerprint" },
"updates": {
  "url": "https://u.expo.dev/00000000-0000-0000-0000-000000000000",   ← the same id, after u.expo.dev/
  ...
```

- [ ] **Actions variables and secrets**: repository → Settings → Secrets and variables → Actions. Under **Variables**: `PUBLIC_API_URL` = `https://api.integr8-media.com`; `STAGING_PUBLIC_API_URL` = `https://api.integr8-media.com` for now (Stage 10 changes it to the test box's address); `CONTACT_EMAIL` = `info@integr8-media.com`; `PUBLIC_SIGNUP` = `off`; `WEB_PUBLIC_SENTRY_DSN` and `DESKTOP_PUBLIC_SENTRY_DSN` from I; `EAS_BUILDS` = `enabled`. Do **not** set `EAS_PLATFORMS`: without it phone builds are Android only, which is right until an Apple developer account is connected to Expo (then set it to `all`). Do not set `STORE_SUBMIT` or `COMPANY_APPS` either: unset, company phone builds are not sent to the stores, and the version release builds every company's apps (Stage 8). Under **Secrets**: `EXPO_TOKEN` from J and `BUILD_TOKEN` from B. Make sure no variable named `DESKTOP_BUILDS` is set to `disabled`.
- [ ] **Know the version rule.** Every merge into `main` runs the release workflow, which reads the version from the root `package.json` and refuses to release a number it has released before. The merge that should produce installers (Stage 6) must bump it: one line in `package.json`, in the same pull request.

> [!NOTE]
> **GitHub also builds the server images**, for Intel and ARM. Each release publishes its own: release `v1.2.2` makes `ghcr.io/minalouisleon/integr8-api:v1.2.2` and `integr8-web:v1.2.2` (and moves `latest` to the newest release). Those are what production pulls. Every push to `main` and `staging` also publishes `:main` and `:staging`, which carry code that is not released yet: they are for the test box only, never for production. The web image bakes in `PUBLIC_API_URL`, `CONTACT_EMAIL` and `PUBLIC_SIGNUP`, which is why they are set here before anything is built. The machine in Stage 4 can either build its own images or pull a release's.

### L. Only if you will build the test box (Stage 10)

- [ ] **A second set of generated secrets** (Part B again): three passwords, four signing keys and three sign-in secrets. A token minted by the test box must not be valid on production, which is what sharing the signing keys would allow, and the box's sign-in server keeps its own test accounts.
- [ ] **A Cloudflare Tunnel**: Cloudflare → **Zero Trust** (free) → Networks → **Tunnels** → Create a tunnel → Cloudflared → name `integr8-test` → on the install step choose **Docker** and copy the token from the command shown. Add two public hostnames: `test.integr8-media.com` → HTTP `localhost:3001`, `api-test.integr8-media.com` → HTTP `localhost:3000`. Cloudflare creates the DNS records. Key sheet: tunnel token.

### M. The AI assistant: a provider, or none

The assistant answers inside the web, desktop and phone apps at three levels: **Help** (how to use Integr8 Plus), **Insights** (Help, plus reading the company's own records, such as "how many open jobs?") and **Agent** (Insights, plus preparing a change, such as a new customer, that a person confirms before it is made). The server talks to **at most one** AI provider, the one named in `AI_PROVIDER`; there is no automatic switch to another. Pick one of the five below and do only its part. Skip all of this if you are not turning the assistant on yet: everything else works without it.

| Choice                  | Setting     | What you need                                 | Good for                                                                                            |
| ----------------------- | ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| No AI: the help library | `none`      | Nothing: no account, key, model or price list | Starting out, or companies that pay for no AI. Help only; answers are the help guide's own articles |
| OpenAI                  | `openai`    | Part M2                                       | All three levels; the guide's default example (`gpt-6-luna`)                                        |
| Groq                    | `groq`      | Part M3                                       | Very fast, low-cost open models; has a free tier                                                    |
| Google Gemini           | `gemini`    | Part M4                                       | Low-cost Flash models; has a free tier                                                              |
| Anthropic (Claude)      | `anthropic` | Part M5                                       | Careful answers and tool use; works with the current Claude 5.x models (M5)                         |

> [!NOTE]
> **Whichever you pick**, you will write down the same four things for the key sheet: the provider's **API key**; a **model id** for each level (the same one three times is fine; a level with no model is not served, and companies above it get the highest level that has one); each model's **price per million tokens** for input and output (and cached input, where the provider has one); and Integr8's own **monthly ceiling** for the deployment in US dollars (`AI_GLOBAL_MONTHLY_BUDGET_MICROUSD`, written in micros: dollars × 1,000,000, so 5 dollars is `5000000`). The example model ids and prices below come from the providers' pages and third-party price lists in October 2026; model names and prices change without notice, so copy the exact id and today's price from the provider's own **Models** and **Pricing** pages.

#### M1. No AI: the help library only

- [ ] **Nothing to sign up for.** In Stage 3 the server gets `AI_ENABLED=true` and `AI_PROVIDER=none`, and every company is answered from the help library whatever its plan says: the best-matching help article's title, summary and closest paragraph, with links to up to three articles. No tokens, no money, no shares; the company's message limits still count. You can add a real provider later without changing anything for the companies, then move plans to AI answers one by one (Stage 5).

#### M2. OpenAI

- [ ] **Create the account** at `platform.openai.com` with `info@integr8-media.com`, as an organisation (Integr8 Media). This is the developer platform, billed separately from any ChatGPT subscription.
- [ ] **A project for this deployment**: the project picker (top left) → **Create project**, named `integr8-production`. Keys, limits and usage are then this deployment's alone.
- [ ] **Prepaid credit**: Settings → **Billing** → add a payment method and buy credit (start small, for example $10). Turn **auto recharge** off while you learn how much the companies use. When the credit runs out the assistant pauses on its own (Stage 5) and nothing else in the product is affected.
- [ ] **Limits and alerts**: Settings → **Limits** (organisation and the project): a monthly budget and an email alert at, say, 50% and 80%. Integr8 cannot read your OpenAI balance; these emails are how you hear it is low.
- [ ] **Create the API key**: the project → **API keys** → **Create new secret key**, named `integr8-production`, owned by the project, permissions **All**. Copy it (`sk-proj-…`, shown once). Key sheet: `AI_OPENAI_API_KEY`.
- [ ] **Model and prices**: the example is `gpt-6-luna` for all three levels at $0.10 input, $0.01 cached input and $0.50 output per million tokens (search results, 15 October 2026; confirm on OpenAI's Models and Pricing pages, including that the model supports tool calling). It is a reasoning model: Stage 3 sets `AI_OPENAI_REASONING_EFFORT=none`.
- [ ] **Read OpenAI's data terms** (Settings → **Data controls**) before letting companies' own records reach it at Insights and Agent. The assistant asks OpenAI not to store its requests.

#### M3. Groq

- [ ] **Create the account** at `console.groq.com` with `info@integr8-media.com`. The free tier works for trying it, with low rate limits; before customers depend on it, add a payment method under **Settings → Billing** to move to the paid (Developer) tier and its higher limits.
- [ ] **Create the API key**: **API Keys** → **Create API Key**, named `integr8-production`. Copy it (`gsk_…`, shown once). Key sheet: `AI_GROQ_API_KEY`.
- [ ] **Models and prices**: the **Models** page lists the ids exactly as the API takes them, and which support **tool use** (Insights and Agent need it). Example: `openai/gpt-oss-20b` for Help ($0.075 in, $0.30 out per million) and `openai/gpt-oss-120b` for Insights and Agent ($0.15 in, $0.60 out). Groq's cached input is half price; leave it out of the price list unless you want to model that.
- [ ] **Spend limits and data**: set a spend limit under Billing if your plan offers one, and read Groq's data and privacy terms before allowing company records (Insights, Agent).

#### M4. Google Gemini

- [ ] **Create the key** at `aistudio.google.com`, signed in as the Integr8 Media Google account: **Get API key** → **Create API key**, in a Google Cloud project named `integr8-production` (AI Studio offers to create it). Copy it (`AIza…`). Key sheet: `AI_GEMINI_API_KEY`.
- [ ] **Turn on billing for that project** (AI Studio → the key's project → **Set up billing**) before customers use it. The free tier is rate-limited, and its terms let Google use what is sent to improve its products; on the paid tier they do not. Check the current Gemini API terms before allowing company records.
- [ ] **A budget alert**: Google Cloud console → **Billing** → **Budgets & alerts** → a monthly budget for the project with email alerts at 50% and 80%.
- [ ] **Models and prices** (ai.google.dev → Models and Pricing): example `gemini-2.5-flash-lite` for Help ($0.10 in, $0.40 out per million) and `gemini-2.5-flash` for Insights and Agent ($0.30 in, $2.50 out). Newer Flash models exist at other prices; any model that supports function calling works.

#### M5. Anthropic (Claude)

- [ ] **Create the account** in the Claude Console (`platform.claude.com`) with `info@integr8-media.com`, as an organisation. **Billing** → add a payment method and buy prepaid credits; **Limits** → a monthly spend limit, and an email notification threshold.
- [ ] **Create the API key**: **Settings → API keys → Create key**, named `integr8-production`, in its own workspace if you use workspaces. Copy it (`sk-ant-…`, shown once). Key sheet: `AI_ANTHROPIC_API_KEY`.
- [ ] **Models and prices.** Every current Claude model works: `claude-haiku-5-5` for Help ($0.10 in, $0.50 out per million, for prompts up to 100,000 tokens) and `claude-sonnet-5-5` for Insights and Agent ($2 in, $10 out). These models think before answering, and the thinking counts against the plan's **Max output tokens**: Stage 3 sets `AI_ANTHROPIC_EFFORT=low`, and give the plan about 1,500 output tokens (Stage 5). The older `claude-haiku-4-5` ($1 / $5) and `claude-sonnet-4-6` ($3 / $15) also still work, without the effort line. Check the ids and prices on Anthropic's Models and Pricing pages.
- [ ] **Read Anthropic's commercial terms on data** before allowing company records (Insights, Agent).

> [!NOTE]
> **Changing provider later** is only settings: a different `AI_PROVIDER`, that provider's key line, its `AI_MODEL_*` ids and its price rows, then a restart (Stage 3). Usage and spend history stay; companies notice nothing but the answers. A missing key or Help model never stops the server: companies get help-library answers until it is fixed.

### The key sheet

Every value, where it came from, and where it goes. `deploy/.env` is the one file on the machine (Stage 3); "GitHub" means Actions variables and secrets (Part K); "dashboard" means the product's own platform dashboard (Stage 5).

| Value                                                                                                                                          | From                                  | Goes to                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`, `INTEGR8_APP_PASSWORD`, `INTEGR8_AUTH_PASSWORD`                                                                           | Part B, generated                     | `deploy/.env`, each twice (Stage 3)                                                                   |
| `AUTH_SIGNING_KEY_ID`, `AUTH_SIGNING_KEY`, `AUTH_VERIFICATION_KEYS`, `PLATFORM_SECRET_KEY`                                                     | Part B, generated                     | `deploy/.env`; `AUTH_VERIFICATION_KEYS` also Expo, as `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` (Stage 8)  |
| `SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_DB_PASSWORD`                                                           | Part B, generated                     | `deploy/.env`, the three together                                                                     |
| `HR_DATA_KEY`                                                                                                                                  | Part B; optional for HR secrets       | `deploy/.env` when used; back up with the database; never regenerate                                  |
| `ETA_CREDENTIALS_KEY`                                                                                                                          | Part B, generated                     | `deploy/.env`; also with the database backups. Never regenerated for an existing database             |
| `BUILD_TOKEN`                                                                                                                                  | Part B; optional until company builds | `deploy/.env` and GitHub secret (Part K), the same value when used                                    |
| SSH public key                                                                                                                                 | Part A                                | Oracle's instance form (Stage 1)                                                                      |
| `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                                                            | Part D                                | `deploy/.env`                                                                                         |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                                                                                 | Part F                                | `deploy/.env`                                                                                         |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                                                   | Part G (test mode; live in Stage 9)   | `deploy/.env`                                                                                         |
| Stripe price IDs                                                                                                                               | Part G                                | Dashboard → Plans (Stage 5)                                                                           |
| `MAPBOX_ACCESS_TOKEN`                                                                                                                          | Part H                                | `deploy/.env`                                                                                         |
| `SENTRY_DSN`, `WEB_SENTRY_DSN`, `WEB_PUBLIC_SENTRY_DSN`                                                                                        | Part I                                | `deploy/.env`; the public one also GitHub                                                             |
| `DESKTOP_PUBLIC_SENTRY_DSN`                                                                                                                    | Part I                                | GitHub variable                                                                                       |
| `EXPO_PUBLIC_SENTRY_DSN`                                                                                                                       | Part I                                | Expo environment variable (Stage 8)                                                                   |
| Expo Project ID                                                                                                                                | Part J                                | `apps/mobile/app.config.ts`, two places (Part K)                                                      |
| `EXPO_TOKEN`                                                                                                                                   | Part J                                | GitHub secret                                                                                         |
| `google-services.json`, the FCM key                                                                                                            | Part J                                | Expo: the file as `GOOGLE_SERVICES_JSON`, the key under Credentials (Stage 8)                         |
| `PUBLIC_API_URL`, `STAGING_PUBLIC_API_URL`, `CONTACT_EMAIL`, `PUBLIC_SIGNUP`, `EAS_BUILDS`                                                     | Part K, chosen                        | GitHub variables                                                                                      |
| Play Console and Apple developer accounts, their keys                                                                                          | Stage 8, later                        | GitHub (`STORE_SUBMIT` and the store secrets), only when the apps go to the stores                    |
| Second secrets, tunnel token                                                                                                                   | Part L, optional                      | The test box's env file and its `cloudflared` container (Stage 10)                                    |
| The chosen provider's key: `AI_OPENAI_API_KEY`, `AI_GROQ_API_KEY`, `AI_GEMINI_API_KEY` or `AI_ANTHROPIC_API_KEY` (none for `AI_PROVIDER=none`) | Part M                                | `deploy/.env` only. Never a GitHub variable, never anything starting `NEXT_PUBLIC_` or `EXPO_PUBLIC_` |
| Model ids and their prices; `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD`                                                                                | Part M, chosen                        | `deploy/.env` (`AI_MODEL_*`, `AI_MODEL_PRICES`, the ceiling)                                          |
| Plan AI limits and where answers come from, company AI settings, each person's share and dollar cap                                            | Chosen                                | Dashboard (Stage 5 and 7); shares also by the company's owner                                         |

> [!WARNING]
> Four of these can read or change every customer's data or spend real money: the sign-in server's service role key, the R2 secret access key, the Stripe secret key and the AI provider's API key. They exist only in `deploy/.env` on the machine and in your password manager. If one is ever pasted anywhere else, rotate it the same day.

---

## Stage 1 — The Oracle machine

_about 45 minutes_

Oracle's Always Free tier gives every account an ARM machine with up to 4 cores and 24 GB of memory, 200 GB of disk and 10 TB of monthly traffic, with no time limit. It is more than this stack needs. The catch, in busy regions, is a shortage of ARM capacity; that is a one-time annoyance.

### The machine

- [ ] **Compute → Instances → Create instance.** Name it `integr8`.
- [ ] **Image and shape.** The console proposes **Oracle Linux 9**; that works, and so does Ubuntu (**Change image** → **Canonical Ubuntu** → **24.04**). Either way: **Change shape** → **Ampere** → `VM.Standard.A1.Flex` → 4 OCPUs, 24 GB. Check the shape again after changing the image (it sometimes resets). Both carry an "Always Free-eligible" label; if the label is missing you have picked something that costs money. The only later difference is the login user: `opc` on Oracle Linux, `ubuntu` on Ubuntu; the commands say `LOGIN-USER`.
- [ ] **Networking.** Leave "Create new virtual cloud network" and "Create new public subnet" selected; **Assign a public IPv4 address** on.
- [ ] **SSH key.** **Paste public keys** → paste the key from Stage 0, Part A (`Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard` puts it on the clipboard again).
- [ ] **Boot volume.** Tick "Specify a custom boot volume size", enter `100` GB (the free allowance is 200 GB in total). **Create**.
- [ ] **If it says "Out of host capacity"**: nothing is wrong with your account. Try again in an hour, try 2 OCPUs and 12 GB (also free), or a different time of day.
- [ ] **Note the public IP address** from the instance page once it is Running. This is **SERVER-IP** below.
- [ ] **Reserve that IP now**, so it survives recreating the instance and your DNS records never go stale: Networking → IP Management → **Reserved public IPs** → Reserve, then on the instance's VNIC → IPv4 Addresses → Edit → switch the ephemeral address to the reserved one. Done now, the address does not change.

### Two firewalls

Oracle blocks everything but SSH in two places: the console's security list and the machine's own firewall (iptables on Ubuntu, firewalld on Oracle Linux). You open the first here; the setup script opens the second and detects which operating system it is on.

- [ ] **Open 80 and 443 in the security list.** Instance page → under "Primary VNIC" click the **subnet** → **Security Lists** → **Default Security List** → **Add Ingress Rules**: Source CIDR `0.0.0.0/0`, TCP, destination port `80`. A second rule the same way for `443`.
- [ ] **Connect and run the setup script.** It opens the machine's firewall, installs Docker and Caddy (the HTTPS proxy, explained in Stage 2), turns on automatic security updates, and is safe to run twice. On Oracle Linux it also removes the preinstalled `podman`, which conflicts with Docker.

```powershell
# laptop (PowerShell). LOGIN-USER is opc on Oracle Linux, ubuntu on Ubuntu.
ssh LOGIN-USER@SERVER-IP
# type yes at the fingerprint question. The prompt changes to the server's: you are now "on the machine".
```

```bash
# machine (SSH session)
curl -fsSL https://raw.githubusercontent.com/MinaLouisLeon/integr8-plus/main/deploy/vps/setup.sh | bash
exit            # back to PowerShell; log in again so docker works without sudo
```

```powershell
# laptop (PowerShell)
ssh LOGIN-USER@SERVER-IP
```

```bash
# machine (SSH session)
docker compose version
sudo mkdir -p /opt/integr8 && sudo chown "$USER" /opt/integr8
git clone https://github.com/MinaLouisLeon/integr8-plus.git /opt/integr8
cd /opt/integr8
```

> [!WARNING]
> **Idle machines can be reclaimed.** Oracle may stop an Always Free machine that sits at very low CPU for a week, on accounts that have never been upgraded. Upgrading to **Pay As You Go** (Billing → Upgrade) removes that rule and most capacity errors, and Always Free resources stay free; the risk is that anything you create outside the free tier is then charged, so read the "Always Free-eligible" labels. Do it now or in Stage 9.

---

## Stage 2 — Two names, and Caddy

_about 20 minutes, plus DNS wait_

The machine is reachable only by its IP, unencrypted, and nothing is listening. This stage gives it two proper names with the padlock. Three ideas do the work.

**DNS** is the phone book that turns a name into an IP address; Cloudflare keeps yours (Stage 0, Part D). An **A record** says "this name points at this IPv4 address". **HTTPS** means the connection is encrypted and the browser has checked the server really is `app.integr8-media.com`, using a **certificate** that Let's Encrypt issues free to anyone who can prove they control the name. Browsers and phones refuse to send sign-in cookies without it. **Caddy** is a small web server in front of the application: inside Docker the web app listens on port 3001 and the API on 3000, both plain HTTP and only on the machine itself; Caddy listens on the public ports 80 and 443 and forwards each name inward to its port (a **reverse proxy**). Its reason for being here is that it talks to Let's Encrypt by itself: the moment a name points at the machine and appears in its config file, Caddy obtains the certificate, renews it, and redirects HTTP to HTTPS. You never touch a certificate file.

- [ ] **Add two DNS records** in Cloudflare → your domain → **DNS** → Records → Add record. First: Type `A`, Name `app`, IPv4 = SERVER-IP, Proxy status **DNS only** (click the orange cloud so it turns grey), TTL Auto. Second: the same with Name `api`. "DNS only" matters: with the orange cloud on, Caddy could not prove it owns the name. It can be turned on later, after setting Cloudflare's SSL mode to Full (strict); not now.
- [ ] **Tell Caddy the names.** Caddy reads one file, `/etc/caddy/Caddyfile`. The repository has a ready one with the placeholder `YOUR-DOMAIN.com` in it; the second command below swaps that placeholder for `integr8-media.com`. After the four commands, `cat` must show `app.integr8-media.com` and `api.integr8-media.com`, each forwarding to its port. If it still shows `YOUR-DOMAIN.com`, the `sed` line did not run.

```bash
# machine (SSH session)
sudo cp /opt/integr8/deploy/vps/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/YOUR-DOMAIN.com/integr8-media.com/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
cat /etc/caddy/Caddyfile
sudo systemctl status caddy     # active (running) in green; q to leave
```

```text
app.integr8-media.com {
    reverse_proxy localhost:3001
}

api.integr8-media.com {
    reverse_proxy localhost:3000
}
```

- [ ] **DNS has propagated**: on the laptop, `nslookup api.integr8-media.com` prints SERVER-IP under "Address". If not, wait and try again; nothing below works until this does.
- [ ] **The certificate is there**: open `https://api.integr8-media.com` in a browser. A padlock and a plain error page is right (Caddy is reachable; nothing is behind port 3000 until Stage 4). The first visit may take ten seconds while Caddy fetches the certificate. Same for `https://app.integr8-media.com`.

> [!WARNING]
> **If the browser warns about the certificate or cannot connect**, in order of likelihood: DNS has not propagated (the `nslookup` check); port 443 is still closed in one of the two firewalls (Stage 1); the Caddyfile has a typo (`sudo journalctl -u caddy -n 30` names the line). Let's Encrypt allows five failed attempts per hour per name, so fix the cause before retrying.

> [!NOTE]
> **Why two names.** The phone and desktop apps talk to the API directly, so it needs a public name of its own. The web app's server reaches the API over Docker's private network and never goes through `api.`; only browsers, phones and Stripe's webhook use it. Keeping the two apart also means a browser's cookies for the web app are never sent to the API by accident.

---

## Stage 3 — The env file, filled once from the key sheet

_about 30 minutes_

One file holds every setting: `deploy/.env` on the machine. It is never committed. Start from the template and fill it from the key sheet, in the order below. `nano` is a small editor inside the SSH session: arrow keys move, type to edit, **Ctrl-O** then Enter saves, **Ctrl-X** leaves; right-click pastes in the Windows Terminal.

```bash
# machine (SSH session)
cd /opt/integr8
cp deploy/.env.example deploy/.env
nano deploy/.env
```

- [ ] **Mode.** `APP_ENV=staging` for now. Stage 9 flips it to `production`, which makes the API refuse to start if any service below is missing; staging mode starts anyway and only warns, which is kinder while you check each piece.
- [ ] **Addresses.** Replace `your-domain.example` everywhere: `PUBLIC_API_URL`, `API_PUBLIC_URL`, `AUTH_ISSUER` = `https://api.integr8-media.com`; `WEB_APP_URL`, `API_UPDATE_URL` = `https://app.integr8-media.com`; `API_CORS_ORIGINS=https://app.integr8-media.com,tauri://localhost,http://tauri.localhost`. Then `PUBLIC_SIGNUP=off` and `CONTACT_EMAIL=info@integr8-media.com`: there is no public sign-up form (you create every company from the dashboard) and the contact page shows that address.
- [ ] **Database passwords, six lines that must agree.** The three passwords from the key sheet go into `POSTGRES_PASSWORD`, `INTEGR8_APP_PASSWORD`, `INTEGR8_AUTH_PASSWORD`, and again into the three connection addresses below them. An address has the shape `postgres://USER:PASSWORD@HOST:PORT/DATABASE`; replace only the `change-me-…` part of each:

```text
POSTGRES_PASSWORD=aaaa…                 ┐ same value
DATABASE_URL_ADMIN=postgres://postgres:aaaa…@postgres:5432/integr8        ┘

INTEGR8_APP_PASSWORD=bbbb…              ┐ same value
DATABASE_URL=postgres://integr8_app:bbbb…@postgres:5432/integr8           ┘

INTEGR8_AUTH_PASSWORD=cccc…             ┐ same value
DATABASE_URL_AUTH=postgres://integr8_auth:cccc…@postgres:5432/integr8     ┘
```

- [ ] **Signing keys.** Below the database lines is a block headed `# Tokens and secrets`. It has four variables with nothing after the `=`: `AUTH_SIGNING_KEY_ID=`, `AUTH_SIGNING_KEY=`, `AUTH_VERIFICATION_KEYS=`, `PLATFORM_SECRET_KEY=`. The key generator in Stage 0, Part B produced exactly these four lines, each already in the form `NAME=value`. For each one, delete the empty line in the file and paste the whole line from your password manager in its place; the names must match and nothing else on the line changes. The values are long (the second is a few hundred characters) and must stay on one line each. The `AUTH_ISSUER` line just above them was already set in step 2.
- [ ] **Sign-in secrets.** The next block, headed `# Sign-in: the self-hosted Supabase Auth container`, has three variables with nothing after the `=`: `SUPABASE_AUTH_JWT_SECRET=`, `SUPABASE_SERVICE_ROLE_KEY=`, `SUPABASE_AUTH_DB_PASSWORD=`. Paste the last three lines from `keys.txt` in their place, the same way. Leave the commented `# SUPABASE_AUTH_URL=` line as it is: the compose file already points the API at the Auth container. There is no `SUPABASE_URL` line any more, and the API refuses to start if one is added. Afterwards the two blocks read like this, with your own values:

```text
AUTH_ISSUER=https://api.integr8-media.com
AUTH_SIGNING_KEY_ID=integr8-2026-10-09-4bv1e4          ← from keys.txt, line 1
AUTH_SIGNING_KEY={"crv":"Ed25519",…}                    ← line 2, one long line
AUTH_VERIFICATION_KEYS=[{"crv":"Ed25519",…}]            ← line 3, one long line
PLATFORM_SECRET_KEY=6h6lZzXnyuuOeG…                     ← line 4

SUPABASE_AUTH_JWT_SECRET=Rk9P3m…                     ← line 5
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs…       ← line 6, one long line
SUPABASE_AUTH_DB_PASSWORD=x7Kp2Q…                    ← line 7
```

- [ ] **Errors and version.** The block headed `# Release identity and error reporting` comes next. `APP_VERSION` and `API_RELEASE` already say `1.2.2`, matching the root `package.json`; at every release they change to the new number (Stage 11). The three Sentry lines are empty: paste the Node.js project's DSN after `SENTRY_DSN=` and the Next.js project's DSN after **both** `WEB_SENTRY_DSN=` and `WEB_PUBLIC_SENTRY_DSN=`. Afterwards:

```text
APP_VERSION=1.2.2
API_RELEASE=1.2.2
SENTRY_DSN=https://a1b2c3@o123456.ingest.us.sentry.io/4501111
WEB_SENTRY_DSN=https://d4e5f6@o123456.ingest.us.sentry.io/4502222
WEB_PUBLIC_SENTRY_DSN=https://d4e5f6@o123456.ingest.us.sentry.io/4502222
```

Then the last block, headed `# External services`. Every service in it is written the same way: a line that chooses the real service or the fake, followed by its keys **commented out** with a `#` and a space at the start. For each service you change the chooser and remove the `# ` from the start of each key line so it takes effect. A line that still starts with `#` is ignored, which is the usual reason a service "is not configured" after you are sure you pasted the key.

- [ ] **Files.** `MEDIA_STORAGE=local` becomes `r2`. Uncomment the four lines under it and fill them from Stage 0, Part D; the prefix becomes `integr8-production` (the template says `integr8-staging`). Before and after:

```text
# before
MEDIA_STORAGE=local
# CLOUDFLARE_ACCOUNT_ID=
# R2_ACCESS_KEY_ID=
# R2_SECRET_ACCESS_KEY=
# R2_BUCKET_PREFIX=integr8-staging

# after
MEDIA_STORAGE=r2
CLOUDFLARE_ACCOUNT_ID=8f3c2b1a9d8e7f6a5b4c3d2e1f0a9b8c
R2_ACCESS_KEY_ID=4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d
R2_SECRET_ACCESS_KEY=…64 characters…
R2_BUCKET_PREFIX=integr8-production
```

- [ ] **Maps.** `GEOCODER=fake` becomes `mapbox`; uncomment the token line and paste the token from Part H.

```text
GEOCODER=mapbox
MAPBOX_ACCESS_TOKEN=pk.eyJ1IjoiaW50ZWdyOCIsImEiOiJjbG…
```

- [ ] **Push.** `PUSH_SENDER=recording` becomes `expo`. Leave `# EXPO_ACCESS_TOKEN=` commented out: it is only needed if you turn on Expo's "enhanced push security", and you have not. (This is a different token from the `EXPO_TOKEN` GitHub uses.)
- [ ] **HR data key.** If you use sensitive HR fields, find `HR_DATA_KEY=` (below the signing keys) and paste the key-sheet value; otherwise it may stay blank. On a rebuilt machine it must be the **same** value the old machine had, or restored employee numbers cannot be read.
- [ ] **E-invoicing key.** Find `ETA_CREDENTIALS_KEY=` (just after `HR_DATA_KEY`) and paste the value from the key sheet after the `=`, or leave it blank if you have not made one yet: a blank line is the same as no key, and the server starts. Leave `ETA_ALLOW_PRODUCTION=false` as it is. On a rebuilt machine it must be the **same** value the old machine had.
- [ ] **Build token.** Find `BUILD_TOKEN=` (near `CONTACT_EMAIL`). If you build company apps, paste the key-sheet value here and into the GitHub secret of the same name. Otherwise leave it blank; the API starts without it, but GitHub cannot ask the API for a company list.

```text
PUSH_SENDER=expo
# EXPO_ACCESS_TOKEN=
```

- [ ] **Billing.** `BILLING_PROVIDER=recording` becomes `stripe`. Uncomment the two key lines and replace their placeholders with the test-mode secret key and the webhook signing secret from Part G. Leave `BILLING_TRIAL_DAYS` and `BILLING_GRACE_DAYS` as they are (14 and 14: the trial a pays-in-the-app company gets, and the days between a failed payment and read-only).

```text
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_51Qx…
STRIPE_WEBHOOK_SECRET=whsec_3f9a…
BILLING_TRIAL_DAYS=14
BILLING_GRACE_DAYS=14
```

- [ ] **Email.** `EMAIL_SENDER=recording` becomes `resend`. Uncomment the two lines; the key from Part F, and the sender in the form `Name <address>` with an address on the verified domain.

```text
EMAIL_SENDER=resend
RESEND_API_KEY=re_7Kd9…
EMAIL_FROM=Integr8 Plus <info@integr8-media.com>
```

- [ ] **The AI assistant** (skip it to leave the assistant off; nothing else depends on it). The block headed `# The AI assistant`, just before the limits: `AI_ENABLED=false` becomes `true`, and `AI_PROVIDER=recording` becomes the choice from Part M: `none`, `openai`, `groq`, `gemini` or `anthropic`. Then the lines for that choice only, from the blocks below and the key sheet. Each price is in **micros per million tokens**: dollars × 1,000,000, so $0.10 is `100000`, $0.075 is `75000` and $2.50 is `2500000`. The `provider` in each price row is the same word as `AI_PROVIDER`, and the whole price list stays on one line.

**No AI**: two lines, nothing else.

```text
AI_ENABLED=true
AI_PROVIDER=none
```

**OpenAI**:

```text
AI_ENABLED=true
AI_PROVIDER=openai
AI_OPENAI_API_KEY=sk-proj-…
AI_OPENAI_REASONING_EFFORT=none
AI_MODEL_HELP=gpt-6-luna
AI_MODEL_INSIGHTS=gpt-6-luna
AI_MODEL_AGENT=gpt-6-luna
AI_MODEL_PRICES=[{"provider":"openai","model":"gpt-6-luna","inputPerMillion":100000,"cachedInputPerMillion":10000,"outputPerMillion":500000}]
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000
```

**Groq** (the key line is `# AI_GROQ_API_KEY=` in the template; take the `#` off):

```text
AI_ENABLED=true
AI_PROVIDER=groq
AI_GROQ_API_KEY=gsk_…
AI_MODEL_HELP=openai/gpt-oss-20b
AI_MODEL_INSIGHTS=openai/gpt-oss-120b
AI_MODEL_AGENT=openai/gpt-oss-120b
AI_MODEL_PRICES=[{"provider":"groq","model":"openai/gpt-oss-20b","inputPerMillion":75000,"outputPerMillion":300000},{"provider":"groq","model":"openai/gpt-oss-120b","inputPerMillion":150000,"outputPerMillion":600000}]
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000
```

**Google Gemini**:

```text
AI_ENABLED=true
AI_PROVIDER=gemini
AI_GEMINI_API_KEY=AIza…
AI_MODEL_HELP=gemini-2.5-flash-lite
AI_MODEL_INSIGHTS=gemini-2.5-flash
AI_MODEL_AGENT=gemini-2.5-flash
AI_MODEL_PRICES=[{"provider":"gemini","model":"gemini-2.5-flash-lite","inputPerMillion":100000,"outputPerMillion":400000},{"provider":"gemini","model":"gemini-2.5-flash","inputPerMillion":300000,"outputPerMillion":2500000}]
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000
```

**Anthropic**, the current models (Part M5; `AI_ANTHROPIC_EFFORT` is in the template as a commented line, so take the `# ` off it):

```text
AI_ENABLED=true
AI_PROVIDER=anthropic
AI_ANTHROPIC_API_KEY=sk-ant-…
AI_ANTHROPIC_EFFORT=low
AI_MODEL_HELP=claude-haiku-5-5
AI_MODEL_INSIGHTS=claude-sonnet-5-5
AI_MODEL_AGENT=claude-sonnet-5-5
AI_MODEL_PRICES=[{"provider":"anthropic","model":"claude-haiku-5-5","inputPerMillion":100000,"outputPerMillion":500000},{"provider":"anthropic","model":"claude-sonnet-5-5","inputPerMillion":2000000,"outputPerMillion":10000000}]
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000
```

To use the older Claude 4.x models instead (they cost more, and take no effort line):

```text
AI_MODEL_HELP=claude-haiku-4-5
AI_MODEL_INSIGHTS=claude-sonnet-4-6
AI_MODEL_AGENT=claude-sonnet-4-6
AI_MODEL_PRICES=[{"provider":"anthropic","model":"claude-haiku-4-5","inputPerMillion":1000000,"outputPerMillion":5000000},{"provider":"anthropic","model":"claude-sonnet-4-6","inputPerMillion":3000000,"outputPerMillion":15000000}]
```

- [ ] **Only if companies' own records may go to the provider** (the Insights and Agent levels): add one new line under the block naming the provider, for example `AI_PROVIDER_APPROVED_DATA_CLASSES=openai:company_operational` (or `groq:`, `gemini:`, `anthropic:`), once you have read that provider's data terms (Part M). Not needed for `none`: the help library sends nothing anywhere. It is not in the template. Without it, a company on Insights or Agent gets Help answers and a note that company data is not enabled; each company must also agree on its own page (Stage 7).
- [ ] **Know what a mistake here does.** A **missing** value never stops the server: no key or no Help model, or the fake `recording` provider once `APP_ENV=production`, gives every company help-library answers instead; a missing Insights or Agent model only lowers that level; a model with no price row is charged at cautious default rates and marked as estimated. The API, the apps and every other module start and run regardless, and the dashboard's **Plans** page, panel **AI provider** (Stage 5), lists what needs fixing. A **mistyped** value is different: a word that is not one of the allowed ones (`AI_ENABLED=yes`, `AI_PROVIDER=OpenAI` with capitals, a reasoning value other than `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), an address that is not a URL, or a broken `AI_MODEL_PRICES` list (a missing bracket or quote, a line break inside it) makes the API refuse to start, and its log names the line (`Invalid API configuration` or `AI_MODEL_PRICES is not a list of prices`). Fix the line, or put a `# ` back in front of it, and start again. OpenAI only: two optional lines keep their defaults unless you have a reason, `AI_OPENAI_BASE_URL=https://api.openai.com/v1` and `AI_CREDIT_EXHAUSTED_PAUSE_SECONDS=300`; leave `AI_OPENAI_REASONING_EFFORT` out for a model that does not reason, which refuses it. Each provider also has an address line (`AI_GROQ_BASE_URL`, `AI_GEMINI_BASE_URL`, `AI_ANTHROPIC_BASE_URL`) that is right as it is.

- [ ] **PDF documents.** Nothing to add: the template's `PDF_RENDERER=chromium` line stays as it is, and the API image brings Chromium and the fonts. Check that `WEB_APP_URL` is the web app's address, `https://app.integr8-media.com`: every document's QR code points there, and without it the API refuses to make documents. Never set `PDF_RENDERER=recording` here: it prints placeholder pages, and production refuses to start with it.

- [ ] **The two lines at the very end.** `API_MIN_SUPPORTED_CLIENT=0.1.0` stays. `API_UPDATE_URL` was already changed in step 2 to `https://app.integr8-media.com/download`; check it no longer says `your-domain.example`.
- [ ] **Check before saving.** Each database password appears on exactly two lines, no `change-me` or `example` remains, and the only key lines still commented out are `EXPO_ACCESS_TOKEN` and `SUPABASE_AUTH_URL` (plus the commented `AI_` lines you did not need):

```bash
# machine (SSH session)
grep -n 'PASSWORD=\|DATABASE_URL' deploy/.env
grep -n 'change-me\|example' deploy/.env      # should print nothing
grep -n '^# [A-Z_]*=' deploy/.env               # should print only EXPO_ACCESS_TOKEN and SUPABASE_AUTH_URL (and AI_ lines if the assistant stays off)
grep -n '^AI_' deploy/.env                      # the assistant's lines, as you set them
```

> [!WARNING]
> If a password pair does not match, Stage 4 fails at `bootstrap` with `password authentication failed for user "postgres"` (first pair) or the API refuses to start with the same message for `integr8_app` or `integr8_auth`. Postgres keeps the password it was first created with, so after fixing `POSTGRES_PASSWORD` reset the empty database before starting again: `docker compose -f deploy/compose.yml --env-file deploy/.env down -v`, then the normal `up -d`. That throws away the data volume, which is fine before any data exists and never afterwards.

---

## Stage 4 — Start the stack

_about 15 minutes, mostly building_

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f bootstrap migrate auth api
```

The first run builds two images on the machine, ten to fifteen minutes on the ARM cores. Then in order: Postgres starts, `bootstrap` creates the two database roles and the sign-in server's own role and schema, `migrate` applies all 54 migrations and exits while `auth` (the Supabase Auth container) sets up its own tables, the API starts once both are done, then the worker and the web app. Ctrl-C leaves the logs; the containers keep running and restart themselves after a reboot.

- [ ] **The API is ready**: `curl -s https://api.integr8-media.com/health/ready` answers `"status":"ready"`. If `degraded`, the body names the failing check.
- [ ] **The web app answers**: `https://app.integr8-media.com` shows the landing page with a padlock. Its buttons say "Talk to us" and lead to `/contact` with `info@integr8-media.com`; `/sign-up` shows a notice rather than a form.
- [ ] **Storage buckets exist**: new companies get theirs automatically; this makes sure the worker can reach R2 at all. It should print nothing alarming and finish: `docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/media/storage-cli.js provision --all`
- [ ] **The assistant's settings were read**, if you turned it on in Stage 3: `docker compose -f deploy/compose.yml --env-file deploy/.env logs api | grep Assistant:` prints nothing when the AI settings are complete (and always nothing with `AI_PROVIDER=none`). Each line it prints is one thing to fix (for example `Assistant: AI_PROVIDER is openai but AI_MODEL_HELP is not set.`); the rest of the stack runs either way. Stage 5 shows the same list on the dashboard.
- [ ] **PDF documents can be printed**: `docker compose -f deploy/compose.yml --env-file deploy/.env logs worker | grep "PDF documents"` prints `PDF documents can be printed`. If it says `cannot be printed`, the line names the reason; every other job still runs, and documents asked for are marked failed until it is fixed.
- [ ] **The sign-in server is healthy**: `docker compose -f deploy/compose.yml --env-file deploy/.env ps` lists `auth` as _Up (healthy)_. It publishes no port: only the API reaches it, over Docker's own network. If it keeps restarting, `docker compose -f deploy/compose.yml --env-file deploy/.env logs auth` names the cause; the usual one is a `SUPABASE_AUTH_DB_PASSWORD` line that was changed or cut short. Fix the line and run the same `up -d` again: `bootstrap` sets the role's password from the file each time.
- [ ] **Only Caddy faces the internet**: `sudo ss -tlnp | grep -E ':(3000|3001)\b'` shows both ports on `127.0.0.1` and nowhere else. Docker-published ports go round the machine's firewall, so the compose file binds them to the machine itself; Caddy reaches them there.

> [!NOTE]
> If the API refuses to start, its log says exactly which variable is wrong or missing: `docker compose -f deploy/compose.yml --env-file deploy/.env logs api`. Fix the env file and run the same `up -d` command again. Throughout this guide, "restart" means exactly that command; it recreates only the containers whose settings changed.

> [!NOTE]
> **Pulling instead of building.** GitHub publishes the same two images for every release (Stage 0, Part K). Add `API_IMAGE=ghcr.io/minalouisleon/integr8-api:v1.2.2` and `WEB_IMAGE=ghcr.io/minalouisleon/integr8-web:v1.2.2` to `deploy/.env`, with the release you are installing, and from then on deploy with `docker compose … pull && docker compose … up -d` instead of `--build`: no ten-minute build on the machine. Always a release tag, never `:main`, `:staging` or `:latest`: those move by themselves, `:main` and `:staging` with code not released yet. A pinned tag makes each update a one-line change and a rollback "set the previous tag" (Stage 11, parts D and I). If GitHub → your profile → **Packages** shows no images for that release yet, Actions → **Publish images** → **Run workflow** with its tag builds them (30 to 60 minutes). Either way works; this guide shows `--build`.

---

## Stage 5 — The super admin, your staff, the plans, and a first look

_about 30 minutes_

The dashboard at `/platform` is where you onboard companies, set their plan and billing, see what is failing and act as a company. It has no signup; the first account is created from the machine.

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js create you@YOUR-EMAIL.com "Your Name"
```

- [ ] **Save what it prints**: a password and an authenticator secret, shown once. Add the secret to Google Authenticator, 1Password or Authy (scan the `otpauth://` URI as a QR code, or type the secret). This same account signs you in to the desktop app as staff. Because the terminal made it, it is a **staff manager**: the only kind of account that can add and remove colleagues (below).
- [ ] **Sign in** at `https://app.integr8-media.com/platform/sign-in` with the email, the password and a six-digit code. Open **Health**; it should be empty.
- [ ] **Attach the Stripe prices to the plans**: dashboard → **Plans** → for Starter, Standard and Enterprise paste the monthly (and yearly) price IDs from the key sheet. A plan with no price cannot be bought by a company that pays in the app, and the pricing page says so. Companies you invoice never see this.
- [ ] **Look at Companies**: empty. Stage 7 fills it. First, Stage 6 gets you the apps.

### Colleagues: the Staff page

Everybody at Integr8 who needs the dashboard or the staff desktop app gets their own account; nobody shares yours. The dashboard's **Staff** page (last in the sidebar) lists everybody who can sign in. Everybody signed in can see the list, but only a staff manager (an account made with the terminal command above) can add people, reset them or remove them. People you add from the page can do everything else in the dashboard and the staff desktop app, but they never get those buttons, and the API refuses them if they try another way.

- [ ] **Add a colleague.** Dashboard → **Staff** → **Add a staff member** → their name and email address → **Add**. A yellow panel shows their password, authenticator secret and `otpauth://` link, **once**. Copy them into a private message (a password manager's share, or Signal; not a group chat), then press **I have sent them**. They sign in at `https://app.integr8-media.com/platform/sign-in`, and the same details open the staff desktop app.
- [ ] **Check what they see.** Their row says _Added by_ your name; yours says _Terminal account_. When they open the Staff page, it tells them only a terminal account can add or remove staff, and shows no buttons.
- [ ] **Lost phone or forgotten password?** On their row: **New password and code** → confirm. Their old details stop working at once and they are signed out. Send the new ones the same private way.
- [ ] **When somebody leaves:** on their row, **Remove** → confirm. They are signed out of the dashboard, the staff desktop app and any company they were acting as, there and then, and cannot sign in again. The account is kept as _Removed_ so the audit log still names them. Adding the same address again brings them back with new details.

> [!NOTE]
> **A terminal account is only changed from the terminal**, yours included: the Staff page has no buttons on it. That keeps the power to manage staff with whoever holds the server. To give a colleague that power too, or to lock out a terminal account, run one of these on the machine:

```bash
# machine (SSH session), from /opt/integr8
# Make somebody a staff manager (new account, or promote one added from the page;
# it also resets their password and code and prints them once):
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js create colleague@YOUR-EMAIL.com "Their Name"

# Take any account off the staff, terminal ones included:
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js remove colleague@YOUR-EMAIL.com

# Everybody, and which accounts are staff managers:
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js list
```

> [!WARNING]
> **Keep at least two staff managers.** If the only one loses their phone, the fix is `admin-cli create` with the same address on the machine, which resets them. That works, but only for somebody who can SSH in. Every account that existed before the Staff page arrived (version 0.1.4) is a staff manager automatically.

### The AI assistant: is the server ready, and what does each plan allow

Turning the assistant on takes four switches, each of which can be undone on its own: the server (Stage 3), the **plan** (here), the **company** (its apps and, if you like, its own limits; Stage 7) and, for AI answers, each **person's share** (Stage 7). Every plan starts at **Off**, so nothing changes for any company until you set a plan. Skip this part while the assistant stays off.

- [ ] **Check the server is ready.** Dashboard → **Plans** → the **AI provider** panel. With a provider it should say **Active provider** (OpenAI, Groq, Gemini or Anthropic), **State** Ready, **Levels served** Help, Insights and Agent, the model beside each level, and **Has a price row** Yes (**Cached-input price** only matters for OpenAI). With `AI_PROVIDER=none` it says **None (help library only)**, that every company is answered from the help library, and lists nothing to fix. Anything under **What needs fixing** is a line in `deploy/.env` (Stage 3); fix it and restart with the usual `up -d`.
- [ ] **Give each plan its AI policy.** Still on **Plans**, each plan has an **AI assistant** section → **Change**. Fields: **Level** (Off, Help, Insights, Agent); **Answers come from**: **An AI model** or **The help library (no AI)** — under the library the token limits, cost cap and model ceilings are hidden and do not apply, the level runs at Help, nobody needs a share, and **Unlimited messages** needs no cost cap; **Quota mode** (daily, monthly, both) with **Messages per day** and **per month** for the whole company; **Tokens per day** and **Tokens per month** (input plus output, company-wide, empty for no limit); **Monthly cost cap (USD)**, the company's own ceiling (required if you tick **Unlimited messages**); the per-message token and call ceilings (leave as they are); whether conversation history is kept and for how many days. A **Reason** goes into the audit log. Saving reaches every company on the plan within thirty seconds.
- [ ] **A starting point**, to adjust once you see real use: Starter at Help, daily and monthly, 50 messages a day and 1,000 a month, 200,000 tokens a day and 2,000,000 a month, cost cap $2. Standard at Insights with twice that and $5; Enterprise at Agent with four times and $10. At the example prices, 2,000,000 tokens cost well under a dollar, so the cost cap is a safety net, not the usual limit. Leave the trial plan at Off, or at Help from the help library, which costs nothing. With `AI_PROVIDER=none`, every plan answers from the help library anyway; set the levels you will sell, so moving a plan to AI answers later is one switch.

> [!NOTE]
> **Who sees what.** The dashboard shows numbers: messages, tokens, dollars. A company's owner sees only percentages: how much of the company's allowance is left, how much is handed out in shares, and when it resets. A member sees their own percentage left. Nobody in a company ever sees a token count, a price or a dollar figure.

> [!WARNING]
> **When the OpenAI credit runs out**, OpenAI refuses calls with a billing error. The assistant tells that apart from a busy moment and stops asking OpenAI for five minutes (`AI_CREDIT_EXHAUSTED_PAUSE_SECONDS`); the **AI provider** panel shows the pause and the API log says `ai.provider.credit_exhausted`. The question that met the billing stop gets "temporarily unavailable" and costs nothing; during the pause every question is answered from the help library, with a first line saying only the help guide can answer for now. Nothing else in the product is affected. Top the credit up in OpenAI; model answers come back after the pause. With the other providers, an empty balance shows as a failed call: top up and ask again. There is no automatic switch to another provider. `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD` is a separate stop of your own: when the month's spend reaches it, every company is refused until the month ends or you raise it and restart.

---

## Stage 6 — The staff desktop app, built by GitHub

_about an hour, mostly waiting_

Nothing is built on your laptop or on the server. Every merge into `main` runs the release workflow: the **staff** desktop app, the one you and your colleagues install, is built on GitHub's own Windows, macOS and Linux machines and the installers attached to a GitHub release. It is called **Integr8 Plus Staff** and its sign-in screen has only the staff door: a company's people never install it. Each company gets apps of its own, desktop and phone, in Stage 8, once the company exists. Stage 0, Part K set everything the workflow needs; this stage triggers it and installs the result.

- [ ] **Make the current release.** The latest release is `v1.2.2`; if Releases shows it with green jobs, skip to the next step. If a later version is already current when you set up, use its newest green release. Otherwise bump the root `package.json` version through a pull request and merge it into `main`; the **Actions** tab shows the release workflow. The Windows installer takes about 15 minutes and macOS about 25. No generic phone app is built here; company phone apps are built in Stage 8. If a job is red, open it and fix the named missing variable or secret before continuing.
- [ ] **Desktop: install the staff app from the Releases page.** Repository → **Releases** → `v1.2.2` (or the newest green `v…`) → Assets: a `-setup.exe` and an `.msi` for Windows, a `.dmg` for macOS, a `.deb` and an `.AppImage` for Linux, named `Integr8 Plus Staff` (from the next release, `integr8-plus-staff_…`). Download the Windows `-setup.exe` and run it: it is the one that updates itself in place. If an older `Integr8 Plus` from before this change is installed, it stays as a separate app; uninstall it from Windows Settings → Apps. Until the installers are code-signed, Windows warns before it runs: the note at the end of this stage says what to click.
- [ ] **Sign in as staff.** The staff app has one door: super admin email, password and authenticator code, then a company to open and a reason. This is the only way into the form builder, the job-type editor and the **Company branding** screen, because all three are Integr8's to run for each company; the company's own people get a desktop app whose sign-in has only their door (Stage 8). The signed-in screens are a dashboard with a side menu grouped by Work, CRM, Sales, Finance, Accounting, HR, Inventory, Operations, Set-up and Company (each business group appears only for a company with that module switched on, Stage 7); the menu shrinks to icons with the button at its foot and remembers the choice, and the language switch lives in its footer. With no companies yet, stop here and come back in Stage 7. If sign-in says "You appear to be offline" while the web app works, the installer was built before `claude/desktop-csp` was merged, or without `PUBLIC_API_URL`; check `docker compose … logs api | grep platform/auth` on the machine: no line means the request never left the app.
- [ ] **Phone: nothing to install yet.** There is no generic phone app any more and no staff login on the phone: a phone app is built for one company, carries its name, icon and colours, opens on its website, and signs in only its people. The first one is built in Stage 8, for the test company Stage 7 creates.

> [!NOTE]
> **Each new version from now on**: merge into `main` with the version bumped and wait for the release (the version release builds every company's apps too, Stage 8); then the machine, Stage 11. Installed desktop apps, the staff one and every company's, offer the new version themselves once the parts below are done. Phones take the JavaScript side over the air.

### Desktop apps that update themselves

Each version release attaches signed update files and a small `latest.json` to its release, and the web app passes the newest one on at `https://app.integr8-media.com/desktop-updates/…` (the staff app asks `/staff/…`, a company's app `/<short name>/…`). An installed app asks when it starts and every six hours, and shows a strip under its top bar: **Install now** downloads the update, checks it against the key the app was built with, and installs it. This needs no certificate from Microsoft or Apple, only the key below.

- [ ] **The updater key, once.** The public half is already in the repository (`apps/desktop/src-tauri/updater.key.pub`, and `pubkey` in `tauri.conf.json`); the private half is the file `updater.key` next to it on the computer that made it, never committed. If you have it, add GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` = the file's contents and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = its password. If nobody has it, make a new pair on your laptop, `pnpm --filter @integr8/desktop tauri signer generate -w src-tauri/updater.key` (it asks for a password), put both secrets in GitHub, and replace `updater.key.pub` and the `pubkey` value in `apps/desktop/src-tauri/tauri.conf.json` with the new public key (the `.pub` file's contents) through a pull request. Keep the private key and its password in the password manager: whoever holds them can sign an update every installed app accepts, and losing them means every app has to be installed again by hand.
- [ ] **The web app knows where the releases are.** In `deploy/.env` on the machine, `GITHUB_RELEASES_REPOSITORY=minalouisleon/integr8-plus`, then restart (Stage 4's `up -d`). Leave `GITHUB_RELEASES_TOKEN` empty while the repository is public; if it ever becomes private, a fine-grained token with **Contents: read** on this repository alone goes there, and the web app then passes the downloads through itself. Check: `curl -s https://app.integr8-media.com/desktop-updates/staff/windows/x86_64/0.0.0` prints the newest release's `"version"` once a release has been built with the key, and nothing before.
- [ ] **Install by hand one last time.** Apps built before this feed existed ask an address that does not exist, so they never hear of an update. Install the first release built with the key over them (staff and each company's), once; from then on they update themselves.
- [ ] **Try a real update on each system before relying on it**, on a spare Windows PC, a Mac and (if anybody uses it) Linux: install one release, let the next one finish, open the app and wait a few seconds. The strip says "Version … of this app is ready"; **Install now**. Windows closes the app and opens the new version; macOS and Linux say to close and reopen it. The dashboard's **Releases** page then counts the new version among the apps in use. If no strip appears, the release log's "Stamp" step says whether the key was there, and the `curl` above whether the web app sees the release.

### Code signing, when you buy certificates

Optional, and not needed for updates. Without it the installers work, but Windows and macOS warn the first time one is opened (the note below says what people click). With it, the release workflows sign every installer, the staff app's and every company's, as soon as the secrets exist; each one is used only when all of its secrets are there. Both Windows and macOS builds carry on being made either way.

- [ ] **Windows: Azure Artifact Signing, or a code-signing certificate.** Azure Artifact Signing (formerly Trusted Signing) is the cheapest that works on GitHub's machines, about $10 a month: check first that Integr8 Media is eligible (Microsoft verifies the organisation and has limited which countries it accepts), then in the Azure portal create an Artifact Signing account and a public-trust certificate profile, and an app registration with the **Artifact Signing Certificate Profile Signer** role on it. GitHub secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`; variables `AZURE_SIGNING_ENDPOINT` (for example `https://weu.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`. The other way is an OV code-signing certificate from a certificate authority (Sectigo, DigiCert, SSL.com), about $200 to $400 a year, after the authority checks the company's documents (days to weeks). Since June 2023 a new certificate's key lives on a USB token or in the authority's cloud signing service, not in a file, so the workflow's file route (`WINDOWS_CERTIFICATE` = the `.pfx` as base64, `WINDOWS_CERTIFICATE_PASSWORD`) only fits a certificate you hold as a `.pfx`; a cloud signing service needs its own command wired into the workflow first.
- [ ] **Apple: the Developer Program and a Developer ID certificate.** The Apple Developer Program as an organisation, about $99 a year (a D-U-N-S number is asked for; the same account Stage 8 uses for the App Store). developer.apple.com → Certificates → **+** → **Developer ID Application**, from a certificate request made in Keychain Access on a Mac (or with `openssl` in Git Bash). Export it with its key as a `.p12` with a password. GitHub secrets: `APPLE_CERTIFICATE` = the `.p12` as base64 (`base64 -w0 cert.p12` in Git Bash), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` = the certificate's name, `Developer ID Application: Integr8 Media (TEAMID)`. Notarisation, which macOS needs as well, uses the App Store Connect API key of Stage 8, part B (`ASC_API_KEY`, `ASC_KEY_ID`, `ASC_ISSUER_ID`) when it exists; otherwise `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from account.apple.com) and `APPLE_TEAM_ID`.
- [ ] **Check the next release.** The desktop jobs' "Stamp" step prints `windows signing: certificate` or `sign command`, and macOS notarisation adds several minutes to the macOS job. On Windows, the installer → right-click → Properties → **Digital Signatures** names Integr8 Media. A new certificate starts with little SmartScreen reputation, so the blue warning can still show for a few weeks; on macOS a signed and notarised app opens without the Privacy & Security step.

> [!NOTE]
> **Installing before the apps are code-signed.** Send this with the download links, to staff and to every company. **Windows**: "Windows protected your PC" appears; click **More info**, then **Run anyway**. On Windows 11 with **Smart App Control** on, an unsigned app can be blocked with no way past it, and a company's managed PCs may block it by policy: those need a signed build, or their IT person's decision. **macOS**: the first open is refused; open **System Settings → Privacy & Security**, scroll down to Security and click **Open Anyway** beside the app's name, then confirm (right-click → Open no longer gets past it on recent macOS). Only the first open asks; updates install without any of this. The same note for customers is in `docs/deployment/company-apps.md`.

---

## Stage 7 — A customer's day, end to end

_about 45 minutes_

Everything exists now: the stack, the dashboard, both apps, real email. This stage onboards a test company and runs one job through it. There is no customer sign-up form: every company is created here by you, and its forms and job types are built by you in the desktop app. That is the product as sold: a company gets an app that is ready to fill in.

- [ ] **Onboard a company.** Dashboard → Companies → **Onboard a company**: name, short name, plan, seats, **Billing**, the owner's email (use an address you can read) and the company's **website** (`https://…`; its phone app opens on that page before sign-in; optional, it can be added later on the company's page). Billing is the choice per company: **Invoiced by Integr8** (the default: you bill them, the plan is what you set here, no trial and no card in the app) or **Pays in the app** (a trial, then a card through Stripe). Pick Invoiced for this test. Leave **Email the owner's invitation now** unticked: the owner should arrive to a company that is ready, so you set it up first and invite them at the end of this stage. The company is created with its storage bucket, five starter job types and an owner's invitation that has not been sent; the success screen says so and offers **Copy the invitation link**, which you do not need now.
- [ ] **Switch on the company's modules.** Dashboard → Companies → the company → **Features**. Every company has the field work (jobs, forms, customers and sites, timesheets) from the start; the business modules are off until you switch them on, one by one, for the company that bought them: `crm` (leads, opportunities, pipelines), `sales` (quotes, sales orders, deliveries), `finance` (invoices, payments, job profitability), `ledger` (the general ledger), `inventory` (catalogue, stock, vans, counts, serial numbers and batches), `purchasing` (suppliers, purchase orders, receipts, reorder), `assets` (equipment register, QR tags, service history), `hr` (employee profiles and expense claims), `payroll` (Egyptian payroll; needs `hr`), `manufacturing` (bills of materials, assembly, planning; needs `inventory`), `documents` (PDFs made from submissions, with QR codes), `e_invoicing` (ETA e-invoicing; requires `finance` and remains test-only until validated). Switch on the modules for this test company, but leave `e_invoicing` off unless you are following its test-system steps below. Menus, phone screens and the API follow the switches at once.
- [ ] **Build the company's forms and job types as staff.** In the installed staff desktop app, sign in, pick the company, type a reason (ten characters or more; it goes in the audit log), **Open**. A red banner says you are acting as the company. Rename the job types to match the work they do, build a form from a template, attach it to a job type, publish it. Each question card prints its rules in words ("Shown when Result is Fail") and has a **Show when…** button; a question can be **Required only when…**, and a choice question can **Depend on** another so its options narrow with the answer. The company's own people never see the builder: owners and admins read and fill forms, and ask you when something needs to change.
- [ ] **Give the company its look, as staff.** Still acting as the company, side menu → Set-up → **Company branding**: upload a logo (PNG, JPEG or WebP) and a square **app icon** (at least 512 × 512; it becomes the installer and phone icon), pick the accent colour (`#1D4ED8` to try), the sidebar colour, the default theme (light, dark or follow the device) and check the website. The preview shows the shell as it will look before you save. From then on the web app, the company's desktop app and its phone app wear that look, and the sign-in screen remembers it on every device after the first sign-in. The company's owner sees these settings read-only under Settings → Company, with a note that Integr8 sets them; nobody in the company can change the theme.
- [ ] **Invite the owner, now the company is ready.** Dashboard → Companies → the company → **Invitations**: the owner's address, "Waiting, until …" (or "Expired on …" if setting up took more than seven days; it does not matter). **Send invitation** emails a fresh link through Resend, from Integr8, valid for seven days; the panel says "Emailed to …", or why it could not. **Copy a new link** makes the same fresh link without sending anything, for WhatsApp or your own email. Either one stops any earlier link working. Then open the link in a private browser window, choose a name and a password of twelve characters or more, and you are the company's owner, on its dashboard in the web app, in its colours. The invitation disappears from the panel once accepted.
- [ ] **Invite an engineer** as the owner, Settings → People, to a second address you can read. Accept it in another private window.
- [ ] **Create a customer, a site and a job** from the office screens (web app or desktop app, as the owner), load the sample data if you want the screens populated, and assign the engineer. Watch the site get a map pin within a minute: that is Mapbox.
- [ ] **Build the company's own apps.** Dashboard → the company's page → **Website and apps** → tick **Build apps for this company** → Save. Then repository → **Actions** → **Build company apps** → **Run workflow** → type the company's short name, leave the other boxes empty, run. About 25 minutes later the Releases page has `company-<short name>-v1.2.2` with the company's desktop installers and its Android app. Stage 8 explains everything this run did and how it repeats at every release.
- [ ] **Install the company's apps.** From that release: the Windows installer (named after the company) on your laptop, beside the staff app, and the `.apk` on the phone (open the release page on the phone, download, allow installing from this source when Android asks). The phone opens on the company's website with a **Login** button in the header; the desktop app opens on a sign-in screen in the company's colours with only the company door.
- [ ] **Complete the job on the phone, offline.** Press Login in the company's phone app and sign in as the engineer, pull the jobs down, turn on aeroplane mode, complete the job with a photo and a signature, turn aeroplane mode off, and watch it arrive in the office. The photo lands in the company's R2 bucket. `docs/mobile/device-checklist.md` in the repository is the full list of what to try.
- [ ] **Try in-app payment once**, in test mode: on the company's dashboard page → Plan and billing → Billing: Pays in the app → Save. As the owner, Billing → choose a plan → Stripe's checkout → card `4242 4242 4242 4242`, any future date. The plan shows as active within seconds; dashboard → Health → Billing deliveries lists the webhook events as applied. Then switch the company back to Invoiced.
- [ ] **Walk the business modules once**, as the owner, on the web app: a lead converted to a customer and an opportunity dragged across the pipeline board; a quote accepted through its link, turned into a sales order and delivered; an invoice issued and a payment allocated; an item received into a warehouse, transferred to the engineer's van and used on the job from the phone (a serial-numbered item asks which serial); an asset with a printed QR label; a person given a company role under Settings → People → Company roles. Each screen is in the side menu under its group.

### The AI assistant for this company

Only once Stage 3 and the plan's AI policy (Stage 5) are done. For a company answered from the **help library**, two things open it: the company shows it in its apps, and the person's own switch is on (it is, by default). For **AI answers** there is a third: the person needs a **share**, a whole percentage of everything the company is allowed (messages and tokens, per day and per month), kept for that person alone; the shares of a company add up to 100% or less. Nobody starts with a share, so AI answers are closed to everybody until somebody hands them out.

- [ ] **Choose which apps show it.** Dashboard → the company → **Website and apps**: **Assistant in web app**, **in desktop app**, **in mobile app**, all off by default (the same three boxes are on the onboarding form for new companies). The company's owner can change them too: web app → Settings → **Company** → **Assistant**. They choose where it appears, never whether the plan includes it.
- [ ] **Check the company's AI settings.** Dashboard → the company → **AI assistant**: **Policy comes from** The plan (leave it), the **Effective level**, **Answers come from now** (an AI model, or the help library and why: the configuration says so, the server has no AI provider, or its AI settings are incomplete), and today's and this month's use. To give this one company AI answers or the help library regardless of its plan, use **Custom configuration** → **Answers come from**. For a company that needs different limits, **Custom configuration** takes the same fields as a plan and stays when its plan changes; **Reset to plan** goes back. For Insights or Agent to read the company's records, tick **Company data may be sent to the AI provider** (it goes into the audit log) and make sure Stage 3's `AI_PROVIDER_APPROVED_DATA_CLASSES` line is there; otherwise the company gets Help answers.
- [ ] **Hand out the shares, as the owner.** Web app → Settings → **People**: each person has an **Assistant share**; type a percentage and press **Save share**. The heading shows how much is handed out and how much is left; a share that would pass 100% is refused and says how much remains. In the company's desktop app the same list is under **Assistant settings**. Owners and admins can set shares, for people they outrank and for themselves; engineers and viewers cannot. For this test: the owner 50%, the engineer 50%. A company answered from the help library needs none: the People page says so, and shares already set are kept for when it moves to AI answers.
- [ ] **Or set them for the company**, from the dashboard → the company → **AI assistant: members**. It lists every person with their share, their messages and tokens today and this month, their spend, and a **Monthly dollar cap** that only Integr8 can set and the company never sees (empty for no cap). A person who reaches their cap is told their allowance is used up and when it resets, never the amount.
- [ ] **Try it**, as the engineer in the web app (side menu → **Assistant**). A Help question: _How do I create a work order?_ From the help library the answer is the best-matching help article's own words, with links to it and up to two more, and the screen's header says answers come from the help guide. On Insights or Agent, with company data allowed: _How many open jobs?_ On Agent: _Add a customer called Test Ltd_; the assistant prepares it and shows **A change the assistant prepared**, and nothing happens until you press confirm. Then open the company's phone app (once it is built with the assistant, Stage 11, part J): online only, one line with the percentage left.
- [ ] **Try voice** (nothing to set up on the server; it works for every company). **Reading answers aloud** is in every company's assistant, off until a person turns it on: the first visit shows a banner with a **Turn on** button, a switch in the header mutes it again, and each answer has its own **Read this answer aloud** button. **Speaking a question** is only for companies answered by an AI model; a help-library company has no microphone button. Try it as the engineer: web app in Chrome or Edge → **Assistant** → **Speak your question** (allow the microphone when the browser asks), say a question, and the words appear in the box; nothing is sent until you press Send. Firefox has no recogniser, so it shows no button. In the company's desktop app the same button puts the cursor in the box and shows which key to press: **Win+H** on Windows, the microphone key (or fn twice) on a Mac; Linux has none and shows no microphone. On the phone the first tap asks for the microphone and, on iOS, speech recognition; that needs the rebuilt phone app (Stage 8, step 7). Arabic works in each, if the device has Arabic voices and dictation installed.
- [ ] **Know where the audio goes**, in case a company asks. Only text reaches Integr8 Plus. The spoken audio is handled by the device's own recogniser: Google for Chrome and Android, Microsoft for Edge and Windows dictation, Apple for iPhone, Safari and Mac dictation, and never by the company's AI provider. Chrome 139 and later keeps recognition on the device for the languages it has a model for. A spoken question costs the same as a typed one.
- [ ] **See the result on the dashboard**: the company's **AI assistant** panel shows the messages, tokens and spend; **AI assistant: members** shows them per person. The owner, in the web app, sees only a bar with the percentage of the company's allowance left; the engineer sees their own.

> [!NOTE]
> **"The assistant is not available"** always says why: not in the subscription (the plan's level, Stage 5), switched off for the company or for this app (the company's switches), switched off for this person (People → their Assistant switch), **no share** (People → Assistant share; AI answers only), or "temporarily unavailable" (the provider refused the call that was being answered; the **AI provider** panel). Answers that are help articles rather than conversation mean the company is on the help library: the company page's **Answers come from now** says why. "Allowance used up" means the company's or the person's share ran out for the day or month; raise the limit or the share, or wait for the reset shown.

### PDF documents for this company

Only once `documents` is switched on under **Features**. Integr8 staff design the templates; the company makes the PDFs, keeps them, and stops or deletes them. Each PDF has a QR code that opens a page anyone with the link can use, with no account.

- [ ] **Design a template, as staff.** In the staff desktop app, acting as the company: Forms → the form you published → **PDF templates** (the tab is there for Integr8 staff only). Type a name, **New template**. **Page**: the language, the margins, a background for every page (PNG, JPEG or WebP; 2480 × 3508 pixels fills A4 exactly) and, if the first page differs, its own background and top margin. **Document fields**: for this test, a field `certificate`, typed when the PDF is made, required, and marked **What the visitor types**. **Content**: add a heading, a few answers, a table and the QR code, and watch the preview beside it (pick a submission under **Preview with**). **Save template**.
- [ ] **Make a PDF**, as the owner in the web app: open a submitted form (Submissions → one of them) → **Make PDF** → type a certificate number → **Make PDF**. "Making the PDF…" turns into "The PDF is ready" within seconds, with **View** and **Download**. The engineer can do the same from the submissions they can see.
- [ ] **Scan its QR code** with a phone's camera, from the PDF on your laptop's screen. It opens `https://app.integr8-media.com/d/…`: the company, the form, the date, **View PDF** and **Download PDF**, with no sign-in.
- [ ] **Use the register.** Web app, side menu → **Documents**: search by the certificate number, open the document, **Stop the link** and scan the QR code again ("This document is no longer available"), then **Open the link again**. An expiry date stops the link by itself; **Delete** stops it at once and removes the file after the restore window. The phone app lists the same documents under **Documents** once it is rebuilt (Stage 8).
- [ ] **A website key**, only if the company's own website will request company data. Signed in to the dashboard: the company → **Website keys** → **Make a website key**. Any Integr8 staff can create, enable, disable or revoke keys; only the terminal-created staff admin can permanently delete one. The key is shown once: copy it into a shared password-manager item for the website's developer, with `docs/documents/WEBSITE-LOOKUP.md` and the agreed lookup field name (`certificate`). Never email it.

> [!NOTE]
> **A PDF says "Failed"**: its page says why. The usual one is "This server cannot make PDFs at the moment": Stage 4's worker line names the reason. The full list, and what to do for each, is in `docs/documents/RUNBOOK.md`.

### Customer website data API

The company's own website can request one known file/document, job status, quote or invoice at a time. The API key identifies the company website; the company's website must sign in its own customers and check that each customer may access the requested record.

- [ ] **Turn on only the Integr8 grants the company will use**: Dashboard → Companies → the company → **Features** → switch on each needed `website_files`, `website_jobs`, `website_quotes` and/or `website_invoices`. Leave the rest off. These switches belong to Integr8; each one is independent.
- [ ] **Set the company switches**: owner/admin → Settings → **Website access**. Turn on only matching capabilities. Website access works only when both the Integr8 grant and the company switch are on; turning off either stops that capability.
- [ ] **Give the website developer the Vercel setup** in `docs/documents/WEBSITE-LOOKUP.md` and `apps/api/openapi.json`. In Vercel's server environment set `INTEGR8_API_URL` and `INTEGR8_WEBSITE_KEY`. Never use `NEXT_PUBLIC_` or put the key in browser code. Use `POST /v1/website/documents/lookup` for field-based document search, or `GET /v1/website/files/{documentId}`, `/v1/website/jobs/{workOrderId}`, `/v1/website/quotes/{quoteId}` and `/v1/website/invoices/{invoiceId}` for one known record by UUID; there are no list endpoints.
- [ ] **Agree the customer sign-in and record lookup with the company**. Its website validates the customer before using the company-wide key and requests only records that customer may access. Test a valid record, an unknown record, a disabled company switch, a disabled Integr8 grant and a disabled/revoked key before launch.

### The schedule for this company

The desktop **Schedule** plans engineers' visits on a calendar, and each engineer's phone shows their visits on the Today screen. Nothing to switch on: whoever can see every job sees the schedule, and whoever can assign jobs can plan on it.

- [ ] **Plan a visit.** In the company's desktop app, as the owner or a dispatcher: side menu → Work → **Schedule**. Drag a job from **Needs a visit** onto today, tick the test engineer in the dialog and **Save visit**.
- [ ] **Move it, and try a clash.** Drag the visit to another time and drag its bottom edge to make it longer. Then plan another job's visit for the same engineer at the same time: it is refused, saying the engineer is already on another job then. Two visits of the same job may overlap.
- [ ] **See it on the phone.** On the engineer's phone, after the next sync (open the app, or pull the job list), **Your visits today** shows the visit. Once it has started, **Mark visit done**; the schedule shows it done after the phone syncs.

### Skills and certificates for this company

The desktop **Skills and certificates** keeps people's qualifications, and the schedule asks for a reason when nobody on a visit holds what the job needs. Nothing to switch on: owners, admins and HR managers keep the records, and dispatchers see them.

- [ ] **Add a certificate.** As the owner, in the company's desktop app: side menu → Work → **Skills and certificates**. Under the company's list, add a certificate, then record it for the test engineer with an expiry date a week from today.
- [ ] **Make a job type need it.** Side menu → **Job types**: on a job type, change its required qualifications and choose the certificate. Then create a job of that type.
- [ ] **Try the warning.** On the **Schedule**, plan a visit of that job for someone who does not hold the certificate: the visit dialog lists who lacks what and asks for a reason. Give one and save; the job's history shows it. A visit for the test engineer before the expiry date needs no reason; one after it does.
- [ ] **See it on the phone.** After the test engineer's phone syncs, **My qualifications** on the home screen shows the certificate and its expiry, and the job shows what it needs.

### Contracts, maintenance and deadlines for this company

Contracts say which jobs a customer's agreement covers, maintenance plans make an asset's servicing jobs ahead of time, and deadlines count down from when a job is created. Nothing to switch on for contracts and deadlines; maintenance plans need the assets module.

- [ ] **Set a deadline.** As the owner, in the company's desktop app: side menu → Work → **Deadlines** → rules. Give **Urgent** a response time of 2 hours, around the clock, and save. Create an urgent job: its screen shows the response deadline counting down. Dispatch it, and the deadline shows as met.
- [ ] **Add a contract.** Side menu → Operations → **Contracts**: add a contract for the test customer that covers one of its sites only. Create a job at that site: it shows **Covered** with the contract's number. A job at another of the customer's sites shows **Chargeable** and why.
- [ ] **Add a maintenance plan.** This needs the assets module switched on for the company (Stage 7, Features). On an asset's screen, under **Maintenance plans**, add a plan every 3 months starting a few days from today, made 30 days ahead. After the worker's next daily run the job waits under **Needs a visit** on the schedule, and Work → **Maintenance** shows it as made.
- [ ] **See it on the phone.** Put the test engineer on that job. After the phone syncs, the job shows that it is planned maintenance, whether the contract covers it, and its deadline when it has one.

### E-invoicing (ETA) for this company

Only once e-invoicing has been tested, and only on the ETA's test system (PreProd). It stays off for every company until Integr8 switches it on, and the company needs `finance` on as well. You need the company's ETA registration details, the client ID and secret of its ERP system from the ETA portal, and the public certificate of its signing token; `docs/e-invoicing/ACCOUNTANT-CHECKLIST.md` is the list to send the company's accountant.

- [ ] **Switch it on**, in the staff desktop app acting as the company: side menu → **E-invoicing switch** → **Turn e-invoicing on** → **Yes, change it**. The screen also says whether `finance` is on and whether this server has `ETA_CREDENTIALS_KEY`. The dashboard's **Features** has the same switch (`e_invoicing`). **Turn e-invoicing off** closes its screens at once and stops anything waiting from being sent; nothing is deleted.
- [ ] **The company's details**, as the owner in the web app: side menu → **E-invoicing** → **Settings**. Tick **E-invoicing is on**, keep **PreProd (testing)**, and fill in the tax registration number, registered name, branch ID, activity code, registered address and the default item code, exactly as registered at the ETA. **Save**. Production cannot be chosen: the server keeps it locked.
- [ ] **The credentials**: on the same page, **Client ID** and **Client secret**, **Save credentials**. They are never shown again, not even to you; the page shows only the last four characters of the client ID. Then **Check with the ETA**: "The ETA accepted the credentials." Enter them as the company's own member: Integr8 staff acting as the company are refused.
- [ ] **The signing certificate**: paste the token's public certificate (it begins `-----BEGIN CERTIFICATE-----`) and **Allow this certificate**. Never a private key: the page refuses one.
- [ ] **The ETA's schema**: **List the ETA's document types**, pick the invoice type, version 1.0, and **Fetch this schema**. Every document is checked against it before it is sent.
- [ ] **The codes**: the **Codes** tab. The ETA unit code for each unit the company's invoices use, the ETA tax type and subtype for each tax rate (14% is usually there), and item codes for catalogue items that have their own. All come from the ETA's code tables; nothing is suggested.
- [ ] **Prepare a first document**: open an issued invoice. Its **E-invoicing (ETA)** panel lists what is still missing; **Customer's ETA details** sets the customer's type, registration number and address. When the panel says "Ready to become an ETA document", **Prepare ETA document**, then on the document **Ask for signature**.
- [ ] **The signing queue**, in the company's desktop app on the computer that holds the token: **E-invoicing** → **Open the signing queue** → **Review**. It checks the document on that computer and shows what would be signed, then says "This build cannot sign yet". That is where it stops today: back on the document, **Withdraw the signing request**.

> [!NOTE]
> **What each state means, and what to do when a document says "Not sent", "Outcome unknown", "Rejected" or "Invalid"**, is in `docs/e-invoicing/RUNBOOK.md`. Never send a document again while it says "Outcome unknown": look it up in the ETA portal first, or the ETA receives it twice.

- [ ] **Check the dashboard**: Companies lists the company with its billing mode; its page shows the owner, your impersonation in the history and the storage used; Health stays empty; Sentry shows no errors.

> [!NOTE]
> **Where things live.** Forms, job types, logo, icon, colours and theme: the staff desktop app, acting as the company. Plan, billing mode, modules (Features), website, the "build apps" switch and inviting the owner: the dashboard, the company's page. Company roles (a built-in role with permissions added or taken away): the company's owner, Settings → People. The AI assistant: its level, limits and whether answers come from AI or the help library, on the dashboard (Plans, or the company's **AI assistant** panel); which apps show it, in the company's switches; each person's share, by the owner under Settings → People or by you on the dashboard; dollar caps, on the dashboard only. PDF templates: the staff desktop app, a form's **PDF templates** tab. Website access switches: Settings → Website access for the owner/admin; Integr8's company Features for staff. Website keys: the dashboard, the company's page; any Integr8 staff member may create, enable, disable or revoke, and the terminal-created staff admin may delete. Whether a company has e-invoicing at all: the staff desktop app's **E-invoicing switch** (or Features on the dashboard). E-invoicing settings, credentials, certificates and codes: the company's owner or an admin, E-invoicing → Settings and Codes; signing: the company's desktop app, on the computer with the token. The company's owner changes timezone, currency and working hours in Settings → Company, and nothing about the look. Who may sign up: nobody; `/contact` shows `info@integr8-media.com`.

---

## Stage 8 — Apps built for each company

_about 25 minutes per company, mostly waiting_

Every company gets desktop installers and a phone app of its own: they carry the company's name, icon and colours, open on its sign-in screen (the phone opens on its website first, with a Login button), and refuse anybody from another company. You and your colleagues use the separate staff desktop app from Stage 6, which has only the staff door. There is no staff login on the phone. Stage 7 already did this once for the test company; this stage is the whole picture, so you can do it for every company that follows.

### A. What one run builds

The workflow `Build company apps` reads the company's brand from the API with no sign-in (`GET /v1/public/companies/<short name>/brand`: name, colours, theme, website, icon), stamps it into the desktop bundle, builds Windows, macOS and Linux installers on GitHub's machines, writes the same brand into the phone app's configuration and asks Expo to build it on a channel of its own, then publishes one release named `company-<short name>-v<version>` holding the installers, the Android `.apk` and links to the builds on Expo. Those release assets are the download links; put them on your own download page or any file host when you want.

- [ ] **Switch a company on.** Dashboard → the company's page → **Website and apps**: check the website, tick **Build apps for this company**, Save. Only companies with this on are built; a company you are still setting up stays off.
- [ ] **Set its look first**, from the staff desktop app → Set-up → Company branding (Stage 7). A company without an app icon gets the product's own icon; without colours, the product's own look. Changing the look later repaints the web app and the already installed apps on their next load; the installers and store listings carry the old icon until the next build.
- [ ] **The phone app's build settings, once.** expo.dev → the `integr8-plus` project → **Environment variables** → Add, each for the **production** environment, and for **preview** too with the test box's values if you have one (Stage 10): `EXPO_PUBLIC_SENTRY_DSN` = the React Native DSN from Stage 0, Part I (visibility Plain text); `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` = exactly the `AUTH_VERIFICATION_KEYS` line from the machine's env file (Plain text: public keys, with which the phone checks its offline grant when it has no signal); `GOOGLE_SERVICES_JSON`, type **File**, the `google-services.json` from Part J (visibility Sensitive). Each build profile in `apps/mobile/eas.json` names the environment it reads them from. Without the DSN a phone's crashes reach nobody; without the keys a phone checks only when its offline grant ends, and Sentry says `built_without_keys`; without the file Android phones get no notifications. A phone takes changed values with its next build.
- [ ] **Each company in Firebase, before its first phone build.** Firebase → Project settings → General → **Add app** → Android, package `com.integr8.plus.<short name with - as _>` (a short name starting with a digit gets a `c` in front: `7up` becomes `c7up`), the same id as in Play Console. Download `google-services.json` again, which now lists every app, and replace the `GOOGLE_SERVICES_JSON` file on Expo with it. A company missing from the file still gets its app, without notifications, and the build's log names the package to add.
- [ ] **Build one company now.** Repository → **Actions** → **Build company apps** → **Run workflow**. **company**: the short name. Leave **version** empty (the root `package.json` version), **api-url** empty (the `PUBLIC_API_URL` variable), the platforms empty (Windows, macOS and Linux; Android). The run is three jobs per company; the macOS one is the slow one.
- [ ] **Or build every company.** Same workflow, **company** = `all`. GitHub asks the API for the list using the `BUILD_TOKEN` secret, which has to equal `BUILD_TOKEN` in the machine's env file (Stage 3); if they differ the run stops in its first minute and says so.
- [ ] **Every new version does this by itself.** Merging a version bump into `main` runs the version release, which builds the staff app, the images, and then every switched-on company's apps at the same version, each as its own release. Set the GitHub variable `COMPANY_APPS` = `disabled` if you ever want a release without them.
- [ ] **Hand the apps over.** Give the company the link to the installer for their system (the Windows `-setup.exe`), with Stage 6's note on installing before the apps are code-signed, and, for phones, the `.apk` from the release (open on the phone, download, allow installing from this source). Android keeps the app's signing key on Expo, so the next version installs over the old one; the app also receives the JavaScript side over the air on its channel `production-<short name>`. If the owner has not been invited yet, this is the moment: the company's page → **Invitations** → **Send invitation**.
- [ ] **Notifications for each company's phone app, after its first build.** expo.dev → the project → **Credentials** → Android → the company's application identifier → **FCM V1 service account key**: upload the FCM key from Stage 0, Part J the first time, and choose the same key for every later company. Then, with the app in the background on one of the company's phones, assign a job to that engineer: the notification arrives within half a minute. If it does not, Sentry's React Native project shows `Push registration failed at token` when the build had no `google-services.json` for its package, and Expo's push tool (expo.dev → the project → Push notifications) names a credential problem.
- [ ] **Rebuild the phone apps once to give them voice.** The microphone button on the phone needs new permissions (the microphone, and speech recognition on iOS), and permissions are part of the build, so they cannot arrive over the air. A company's phone app built before voice shows no microphone button until you run **Build company apps** for that company again (step 3, or every company at the next version release) and its people install the new `.apk`. Nothing breaks on an older phone build: it simply has no microphone. The website needs nothing, and the desktop app shows its voice button after the next release's installer is installed.

### B. The stores, when you are ready

Nothing here is needed to use the apps. It is what putting each company's phone app in Google Play and the App Store takes, under the Integr8 Media accounts. Until the `STORE_SUBMIT` variable is `enabled`, company phone builds produce an installable `.apk` and are never submitted; once it is, each build is a store bundle and is submitted when it finishes.

- [ ] **Google Play Console**: an organisation developer account (one-time fee, a D-U-N-S number is asked for). For each company: create the app (package name `com.integr8.plus.<short name with - as _>`), its listing, icon and screenshots, privacy policy page, data safety form and content rating. Google may require the very first upload of a new app by hand: upload the `.aab` from the company's release, then later versions go through the pipeline. In Play Console → Setup → **API access** create a service account with release permission and download its JSON key; GitHub secret `GOOGLE_SERVICE_ACCOUNT_KEY` = the file's contents. Google's "repetitive content" rule can flag many near-identical apps; distinct names, icons, websites and colours help, and asking Play support in writing before the third one is cheap.
- [ ] **Apple**: the Apple Developer Program as an organisation (about $99 a year, D-U-N-S number) connected to Expo once, then `EAS_PLATFORMS` = `all` so iOS is built too. For submission, an App Store Connect API key: secrets `ASC_API_KEY` (the `.p8` file's contents), `ASC_KEY_ID`, `ASC_ISSUER_ID`, and the variable `ASC_APP_IDS` = `{"acme":"1234567890"}` with each company's App Store Connect app id. Apple's guideline 4.2.6 rejects template apps submitted by the service provider rather than the company; the sanctioned routes under one Integr8 account are **Custom Apps** through Apple Business Manager, or **unlisted** apps reachable only by link. The pipeline is the same for all of them.
- [ ] **Turn submission on**: GitHub variable `STORE_SUBMIT` = `enabled`. From the next build, Android goes to the Play internal track as a draft and iOS to App Store Connect, per company; the run's log says what was sent. The release still holds the installers and the Expo links.
- [ ] **Expo plan**: the free plan queues one build at a time and caps builds a month. With several companies at every release, move the Expo account to the Production plan; nothing in the repository changes.

> [!NOTE]
> **How the three builds relate.** One codebase. The staff desktop app (`Integr8 Plus Staff`, Stage 6) shows only the staff sign-in. A company's desktop app and phone app show only the company's sign-in, with the company's name, icon and colours, and the API refuses an account from any other company (`wrong_company`). Which one a build is gets fixed when it is built, never by a switch in the app, so a company's installer cannot be turned into anything else. Companies install side by side: each has its own identifier and its own updater feed.

---

## Stage 9 — Go live: the production switch

_about 2 hours · production_

Everything above works with Stripe in test mode and the API in staging mode. This stage is what separates "works" from "a customer's business runs on it": real money, a database that survives the machine, someone being told when it breaks, and a way to roll back. In this order; each group ends with a check.

### A. The services, for real

- [ ] **Stripe live mode**, only if any company will pay in the app. Activate the account (business details, bank account), switch the toggle to live, repeat Stage 0 Part G there: the live secret key (`sk_live_`), the three products with prices, a **new webhook endpoint** for the same URL with the same events and its live signing secret. Live and test share nothing. Paste the live price IDs into dashboard → Plans. If every company is invoiced, skip this and keep the test keys; production mode only requires that a provider is configured.
- [ ] **Edit the env file**: the live Stripe keys if any, and `APP_ENV=production`. Then:

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env logs api | head -40
curl -s https://api.integr8-media.com/health/ready
```

- [ ] **Check**: the log does not say "Refusing to start in production". If it does, it lists exactly which service is still a fake or which variable is missing; fix and `up -d` again. The health check says `ready`.

### B. The database and backups

- [ ] **The database stays on the machine**, and the sign-in server's tables live in it too: one nightly dump holds both. The next steps are what make that safe; `docs/database/runbook-backup-and-restore.md` is the full version.
- [ ] **Schedule the backup**: `sudo crontab -e` and add the line below. It writes a compressed dump to `/var/backups/integr8` nightly and keeps fourteen. Those files share a disk with the database, so until the next four steps are done each night's log ends with "backups are on this machine only".

```bash
# machine (SSH session), one line inside the crontab editor
0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
```

- [ ] **A bucket for the copies.** Cloudflare → **R2 Object Storage** → **Create bucket**, named `integr8-backups`. Then **Manage API tokens** → **Create API token**: name `integr8-backups`, permission **Object Read & Write**, applied to the `integr8-backups` bucket only, no expiry. Copy its Access Key ID and Secret Access Key (the secret is shown once) into the password manager. Not the media token from Stage 0: that one can delete every company's bucket.
- [ ] **A backup passphrase**: run `openssl rand -base64 32` on the machine and put the result in the password manager beside `HR_DATA_KEY` before going on. The copies are encrypted with it; without it nobody can read them, you included.
- [ ] **rclone and its two remotes**: the commands below, with the token's two values, your `CLOUDFLARE_ACCOUNT_ID` and the passphrase in place of the capitals. `r2` is the bucket; `r2crypt` encrypts everything written through it, so Cloudflare only ever holds ciphertext. The last line shows no error and lists nothing yet.

```bash
# machine (SSH session)
sudo apt-get install -y rclone
sudo rclone config create r2 s3 provider=Cloudflare \
  access_key_id=ACCESS-KEY-ID secret_access_key=SECRET-ACCESS-KEY \
  endpoint=https://ACCOUNT-ID.r2.cloudflarestorage.com no_check_bucket=true
sudo rclone config create r2crypt crypt remote=r2:integr8-backups \
  filename_encryption=off password=PASSPHRASE --obscure
sudo rclone lsf r2crypt:
```

- [ ] **Copy every dump there**: `nano deploy/.env`, add the line `BACKUP_REMOTE=r2crypt:`, then run the backup by hand with `sudo /opt/integr8/deploy/vps/backup-postgres.sh`. Its last lines say `copied integr8-….sql.gz to r2crypt:` and `keeping 30 on r2crypt:`. From now on a night whose copy fails ends with an `ERROR:` line and a failed exit, never quietly.
- [ ] **A heartbeat for the backup**: in Better Stack or healthchecks.io (both have free plans), a new heartbeat expected every day with a few hours' grace. Put its URL in `deploy/.env` as `BACKUP_PING_URL=`. The script calls it after each good night and with `/fail` added after a bad one, so a failed or missing backup reaches you the same day.
- [ ] **A boot-volume backup policy as well**: Oracle → Block Storage → Boot Volumes → the volume → **Backup policy** → Bronze. Check the schedule the console shows for it; it is not nightly. It copies the whole disk, which helps most after a broken operating system, but it stays in the same Oracle account, so it does not replace the R2 copy. Always Free includes five backups.
- [ ] **Rehearse a restore**, before there is anything to lose: the command below restores the newest copy from R2 into a throwaway database container, checks and times it, removes it, and never touches the live database. It needs free disk for one more copy of the database. It ends with a row: add it to the rehearsal log at the bottom of `docs/database/runbook-backup-and-restore.md`. Run it monthly. Before the first customer, also do that runbook's full rehearsal on the test box (Stage 10) and sign in to the restored copy. A backup that has never been restored is a hope.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/restore-drill.sh --remote
```

- [ ] **Keep `HR_DATA_KEY` with the backups**, in the password manager beside them. The dumps hold employees' identity and bank numbers encrypted with it; without the same key a restored database cannot show them.
- [ ] **Keep `ETA_CREDENTIALS_KEY` with the backups** too. The dumps hold each company's ETA credentials locked with it; without the same key every company enters them again.

### C. The machine

- [ ] **Pay As You Go** on the Oracle account if not already (Stage 1 note), so the machine is never reclaimed for being idle.
- [ ] **An uptime check**: UptimeRobot or Better Stack (free tiers) monitoring `https://api.integr8-media.com/health/ready` every 5 minutes, alerting by email and phone. Sentry covers errors inside the app; this covers the app not being there.
- [ ] **Reboot test**: `sudo reboot`, and the stack is back by itself within two minutes. Every container restarts unless stopped, Caddy and Docker start at boot, and container logs are capped at 50 MB each.

### D. GitHub, for the long run

- [ ] **Protect the long-lived branches.** `dev` was deleted by GitHub's "automatically delete head branches" once already. Turn that setting off (Settings → General → Pull Requests) or add `dev` and `staging` to a ruleset that forbids deletion. The flow is feature branch → `dev` → `staging` → `main`, and the checks refuse shortcuts.
- [ ] **Check the release images**: GitHub → your profile → **Packages** lists `integr8-api` and `integr8-web` with the current release's tag (for example `v1.2.2`) for both `amd64` and `arm64`; the version release's **Release images** job makes them. A release made before releases built their own images (`v1.2.2` is one) has none until you run Actions → **Publish images** → **Run workflow** with **tag** = `v1.2.2`, once. The ARM half runs under emulation and takes 30 to 60 minutes.

### E. The first real company

- [ ] **Walk Stage 7 again** with the real company and the billing mode you agreed with them, their real owner and engineer, their real forms, their real logo and icon; then Stage 8 to build and hand over their apps. Watch Health while you do it.
- [ ] **If any company pays in the app, pay with a real card once** on a test company in live mode, confirm the invoice in Billing and the webhook in Health, then refund it in Stripe. It is the only way to know live billing works end to end.
- [ ] **Weekly, five minutes**: dashboard → Health, a glance at Sentry, last night's backup file exists and its log says `copied`, `df -h` on the machine; with the assistant on, the **AI provider** panel (Ready, no credit pause) and OpenAI's own usage page.

### F. The AI assistant, for real

- [ ] **Production mode keeps the assistant honest.** With `APP_ENV=production` the fake `recording` provider never answers: if the env file still says `AI_PROVIDER=recording`, companies get help-library answers and the **AI provider** panel says why. To run without AI on purpose, say `AI_PROVIDER=none`, which raises no warning. An OpenAI address must be `https://`.
- [ ] **Prices checked against the provider's pricing page today**, and `AI_MODEL_PRICES` matching them; the dashboard's spend figures, the company cost caps and the monthly ceiling are all computed from these numbers, not read from the provider.
- [ ] **The provider's credit or billing, spend limits and alerts** sized for real use (Part M), and `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD` raised to match. Decide whether auto recharge stays off; if it does, somebody watches the alert emails.
- [ ] **Each paying company's plan level** and answer source are what they bought, and each company on AI answers has had its shares set (Stage 7) before you tell them the assistant is there.

> [!WARNING]
> Four secrets are now live and can move real money or read every customer's data: the Stripe live key, the sign-in server's service role key, the R2 secret and the AI provider's API key. They exist only in `deploy/.env` on the machine and in your password manager. If one is ever pasted anywhere else, rotate it the same day: Stripe → roll the key; the sign-in server → run the key generator again and replace the three sign-in lines together; Cloudflare → delete and recreate the R2 token; the AI provider → its API keys page → revoke and create a new one. Then edit the env file and `up -d`.

---

## Stage 10 — A test box at home on Ubuntu with Arcane

_about 2 hours · optional_

The Oracle machine is production. This is a second machine that is allowed to break: a PC at home running Ubuntu 24.04 LTS, with the same containers, pulling the `staging` images instead of `main`. Every change is merged to `staging`, tried here, then promoted to `main`. The box already runs Arcane, which looks after Docker stacks, and Webmin and Samba for other things; they stay as they are. Stage 0, Part L collected what it needs.

> [!NOTE]
> **Hardware**: an i5-7500 or similar with **16 GB** and an SSD. With its memory caps the stack needs about 3 GB at most; the rest is left for whatever else the box does. The box never builds images.

- [ ] **Ubuntu 24.04 LTS, SSH, Docker and Compose.** Connect from the laptop with `ssh YOUR-USER@BOX-IP` and check `docker compose version`. Stage 1's setup script is **not** used here: Docker is already installed, and the box needs no Caddy and no open port.
- [ ] **Arcane is running** and its page opens in the laptop's browser at the address you gave it when it was set up. It is how the stack is created and updated below; it runs the same `docker compose` underneath, so the SSH commands shown beside it do the same thing.
- [ ] **Webmin and Samba stay as they are.** They keep their own ports, and the stack publishes only 3000 and 3001, on `127.0.0.1`, so nothing clashes. If Webmin manages the firewall, it needs no new rule: the tunnel below connects outward.
- [ ] **Get the deployment files** (only `deploy/` is used, since the box pulls images):

```bash
# box (SSH session)
sudo mkdir -p /opt/integr8 && sudo chown "$USER" /opt/integr8
git clone -b staging https://github.com/MinaLouisLeon/integr8-plus.git /opt/integr8
```

- [ ] **Change the GitHub variable** `STAGING_PUBLIC_API_URL` to `https://api-test.integr8-media.com` and push something to `staging` (or run "Publish images" from the Actions tab). The staging web image and the nightly desktop installer are then built for the test box.
- [ ] **The env file**, `/opt/integr8/deploy/.env`, as Stage 3 but from Part L's values: `APP_ENV=staging`; `API_IMAGE=ghcr.io/minalouisleon/integr8-api:staging` and `WEB_IMAGE=ghcr.io/minalouisleon/integr8-web:staging` (unreleased code, which is what this box is for; production only ever pins a release tag); the test names (`https://api-test.integr8-media.com` for the three API addresses, `https://test.integr8-media.com` for the two web ones, `API_CORS_ORIGINS=https://test.integr8-media.com,tauri://localhost,http://tauri.localhost`); the **second** set of passwords, signing keys and sign-in secrets; and every fake on: `MEDIA_STORAGE=local`, `GEOCODER=fake`, `PUSH_SENDER=recording`, `BILLING_PROVIDER=recording`, `EMAIL_SENDER=recording`. The box can then never email a real person or charge a card; invitation links and sign-in codes are read from the API log (`docker compose … logs api | grep -o 'https://test[^" ]*accept-invitation[^" ]*' | tail -1`, and `logs api | grep sign_in_code` for a code).
- [ ] **Run the Cloudflare Tunnel connector** with the token from Part L. This replaces Caddy and port forwarding: your router opens nothing, and the web app's sign-in cookies are only sent over HTTPS, so a plain `http://BOX-IP:3001` could never sign in (with the ports on `127.0.0.1` it is not reachable from the network anyway). Cloudflare terminates HTTPS at its edge for the two test names. The connector runs on the host network, so it reaches the two ports on `127.0.0.1`.

```bash
# box (SSH session). Paste the token in place of TUNNEL-TOKEN.
docker run -d --name cloudflared --restart unless-stopped --network host \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token TUNNEL-TOKEN
```

- [ ] **The stack, in Arcane.** Arcane → **Stacks** (called **Projects** in newer versions) → add the existing compose file `/opt/integr8/deploy/compose.yml`, with `/opt/integr8/deploy/.env` as its env file. The stack's name comes from the file: `integr8`. Then **Pull** and **Deploy**. From SSH the same is:

```bash
# box (SSH session) — the same as Arcane's Pull and Deploy
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env pull
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env ps     # auth: Up (healthy)
curl -s https://api-test.integr8-media.com/health/ready
```

- [ ] **Its own super admin** (Stage 5 command, from `/opt/integr8`), then Stage 7 on it with a test company. Sign in once with **Email me a sign-in code**, reading the code from the API log, and change the password under **Change password**.
- [ ] **The nightly apps**: the pre-release on the Releases page (the staff desktop app) and the `preview` phone build on the Expo dashboard talk to the test box. The preview phone build is the one generic phone app left: no company baked in, so it signs in anybody, for your own testing only. Install the nightly desktop app beside the release one; Windows keeps both.
- [ ] **The loop**: merge to `staging` → wait for green → in Arcane, **Pull** and **Redeploy** the stack (or `pull && up -d` over SSH) → test → promote `staging` to `main` with the version bumped → Stage 11 on Oracle. The box's data is disposable: `down -v` and `up -d` gives a clean database, sign-in accounts included. To rehearse a migration on real data, restore a production dump into it first.

> [!WARNING]
> **What the box cannot catch.** Oracle is ARM and the box is Intel. And every fake stays a fake here: a Stripe webhook or a Resend bounce gets its first real test on Oracle, which is why Stage 9 keeps the real-card step.

---

## Stage 11 — Updating to a new version

_about 30 minutes, once per release_

Everything on the machine, in the order that keeps it safe: make the release, back up, bring the new code over, check for new settings, restart, check it worked, then the machine itself, then the apps. Work through it every time a new version comes out. Ticks from the last update can be cleared with **Clear all ticks** at the top, or untick just this stage.

> [!NOTE]
> **What updates where.** The server (API, worker, web app and database schema) updates from this machine. The staff desktop app and every company's desktop and phone apps are built by GitHub from the same release and updated on people's devices (part G). The operating system, Docker and Caddy are the machine's own and update separately (part F). Nothing is ever built on your laptop.

### A. Make the release

- [ ] **Bump the version and merge into `main`.** The root `package.json` version goes up (for example `1.2.2` → `1.2.3`); the change reaches `main` through `dev` and `staging` as usual. That merge is the release.
- [ ] **Wait for it to finish green.** Repository → **Actions**: "Version release" builds the installers and every company's apps (about 30 minutes), then its **Release images** job builds the release's server images, `integr8-api:v…` and `integr8-web:v…` (30 to 60 minutes). Do not touch the machine until all of it is green; a red release changes nothing anywhere.
- [ ] **Read what changed.** Repository → **Releases** → the new `v…`. Look for three things: a **new setting** (part C), a **database migration** (it runs by itself, but it is why part B exists), and a change to `deploy/vps/setup.sh` or the Caddyfile (part F).

### B. Back up first

A migration changes the database in place. A backup from a minute ago turns a bad update into a five-minute restore instead of lost work. Pick a quiet hour: the API is unavailable for about a minute during the restart, and phones simply queue their work and send it afterwards.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lh /var/backups/integr8 | tail -3      # the newest file has today's date and time

df -h /                                    # keep at least 5 GB free
docker system df                           # how much old images are taking
```

- [ ] **A fresh backup exists** with today's date and a size similar to the last one. It holds the sign-in server's accounts too: they live in the same database.
- [ ] **There is room on the disk.** Under 5 GB free: run part H's clean-up first, then come back.

### C. Bring the new code over, and check for new settings

```bash
# machine (SSH session)
cd /opt/integr8
git status --short          # should print nothing; deploy/.env is ignored and never shows
git pull
git log -1 --oneline        # the commit the release was made from

# Settings the new version knows about that your deploy/.env does not have yet
comm -13 <(grep -oE '^[A-Z_0-9]+=' deploy/.env | sort -u) \
         <(grep -oE '^[A-Z_0-9]+=' deploy/.env.example | sort -u)

# Tell the server its new version number (use the real one)
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.2.2/; s/^API_RELEASE=.*/API_RELEASE=1.2.2/' deploy/.env
grep -E '^(APP_VERSION|API_RELEASE)=' deploy/.env
```

- [ ] **`git pull` finished cleanly.** If `git status` listed files, something on the machine was edited by hand: `git diff` shows what, and `git stash` sets it aside so the pull can go ahead (re-apply it afterwards only if you still need it).
- [ ] **New settings added.** The `comm` command prints every variable name the new version expects that your file lacks; nothing printed means nothing to add. For each one, read its comment in `deploy/.env.example` and add it to `deploy/.env` with `nano deploy/.env`. The API refuses to start rather than run with a missing setting, so this is the step that most often matters.
- [ ] **`APP_VERSION` and `API_RELEASE` show the new number.** Sentry groups errors by it, and the dashboard's Releases page compares it with the apps in the field.

### D. Restart on the new version

One command does it all, in order: the new images are built (or pulled), `migrate` applies any new migrations and exits, then the sign-in server, the API, the worker and the web app are recreated. If a migration fails, the API is never started on the new code and the old database is untouched.

```bash
# machine (SSH session) — if the machine builds its own images (this guide's default)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api

# — or, if deploy/.env pins API_IMAGE and WEB_IMAGE to GitHub's release images (Stage 4):
#   put the new release's tag in both lines first (use the real one)
cd /opt/integr8
sed -i -E 's#^((API|WEB)_IMAGE=.*):[^:/]+$#\1:v1.2.2#' deploy/.env
grep -E '^(API|WEB)_IMAGE=' deploy/.env
docker compose -f deploy/compose.yml --env-file deploy/.env pull
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
```

- [ ] **The migrations ran.** The `migrate` log ends with one `applied` line per new migration (or says there was nothing to apply), and exits. Building on the ARM machine takes ten to fifteen minutes; pulling takes one or two. When pulling, the `grep` showed both lines with the new release's tag; `pull` saying `manifest unknown` means that release has no images yet (Stage 9, Part D).
- [ ] **The API started** and its log shows requests being answered, with no error about a setting. Ctrl-C leaves the log; the containers keep running.

### E. Check it worked

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env ps
curl -s https://api.integr8-media.com/health/ready; echo
```

- [ ] **Every service is up.** `postgres`, `auth`, `api`, `worker` and `web` say _Up_ (the API, `auth` and Postgres also _healthy_); `bootstrap` and `migrate` say _Exited (0)_, which is correct for one-off jobs. Anything _Restarting_: `docker compose … logs <name>` says why.
- [ ] **The API is ready**: the `curl` answers `"status":"ready"`.
- [ ] **Sign in to the dashboard** at `https://app.integr8-media.com/platform/sign-in` and open **Health**: nothing new failing. Open one company and one of its work orders in the web app; then on a phone, pull down on today's jobs to sync.
- [ ] **Sentry is quiet** for the next half hour, under the new release number.

### F. The machine itself: operating system, Docker and Caddy

Security fixes for the operating system install themselves every night (Stage 1's automatic updates). The rest — Docker, Caddy and anything held back — is worth doing once a month, or with a release, in the same quiet hour.

```bash
# machine (SSH session) — Ubuntu or Debian
sudo apt-get update
sudo apt-get upgrade -y          # also updates Docker, which came from Docker's own repository
sudo caddy upgrade               # Caddy came from caddyserver.com's build; this replaces it in place
sudo systemctl restart caddy
[ -f /var/run/reboot-required ] && echo "Reboot needed" || echo "No reboot needed"

# machine (SSH session) — Oracle Linux, RHEL, Rocky or AlmaLinux
sudo dnf upgrade -y              # Docker and Caddy included (Caddy from its COPR)
sudo systemctl restart caddy
sudo needs-restarting -r || echo "Reboot needed"
```

- [ ] **Packages upgraded.** When Docker itself is upgraded, every container stops for a few seconds and starts again by itself (they are all `restart: unless-stopped`); check part E again afterwards.
- [ ] **Caddy restarted** and both sites still show the padlock: `https://app.integr8-media.com` and `https://api.integr8-media.com/health`. If `caddy upgrade` says it cannot, Caddy came from a package manager instead; the `apt` or `dnf` line already updated it.
- [ ] **Rebooted if asked**: `sudo reboot`, wait a minute, SSH in again and repeat part E. Everything starts by itself after a reboot.
- [ ] **If the release changed `deploy/vps/setup.sh`**, run it again: `bash /opt/integr8/deploy/vps/setup.sh`. It only changes what is missing or outdated and leaves the rest alone. If it changed `deploy/vps/Caddyfile.example`, compare it with `/etc/caddy/Caddyfile` (`diff deploy/vps/Caddyfile.example /etc/caddy/Caddyfile`), copy over what is new by hand (your file has your real names in it), then `sudo systemctl reload caddy`.

### G. The apps on people's devices

- [ ] **Staff desktop app**: each installed copy offers the new version itself (Stage 6, desktop apps that update themselves): open it and click **Install now** in the strip under the top bar. Only a computer whose app is older than the update feed needs the new `-setup.exe` from the version's release (Releases → `v…` → Assets), installed over the old one. Signing in again is not needed.
- [ ] **Each company's apps**: the version release built them at the same time, one release per company named `company-<short name>-v…` (Stage 8). Their installed desktop apps offer the new version themselves; send new installer links only to people whose app is older than the update feed, or who are installing for the first time. Phones that already have the company's app receive the JavaScript side over the air on their own channel within a day; the new `.apk` only matters when the release notes say the native side changed.
- [ ] **Too-old apps.** When a release needs every app to be new, it raises `API_MIN_SUPPORTED_CLIENT` (the notes say so, and part C's check shows it). Older apps are then told to update, with a link to `API_UPDATE_URL`, instead of failing strangely.

### H. Clean up

Every update leaves the previous images on the disk. Keep them for a day in case you need to roll back, then remove them:

```bash
# machine (SSH session)
docker image prune -f            # images no container uses any more
docker builder prune -f          # the build cache, if the machine builds its own images
df -h /
ls -lh /var/backups/integr8      # the backup script keeps the newest ones and deletes older ones by itself
```

- [ ] **Old images removed** once the new version has run cleanly for a day. Never use `docker volume prune` or `docker system prune --volumes`: the database lives in a volume.

### I. If something goes wrong: rolling back

> [!WARNING]
> **Roll back the code, not the database, unless the database is what broke.** The previous version runs against the new schema in almost every release, because migrations only add. Rolling a migration back can delete data; it is a deliberate last step, not a reflex.

The new version's migrations stay applied when you go back. The previous version's `migrate` step finds them, applies nothing, says in its log that the database is ahead of its build, and exits; then the API, worker and web app start on the newer database, and `/health/ready` says `ready` with a note naming those migrations. Releases up to v1.2.1 are older than that and stop at `migrate` instead: going back to v1.2.1 has its own steps, at the end of part Q.

```bash
# machine (SSH session) — back to the previous release (use its real tag)
cd /opt/integr8
git fetch --tags
git checkout v1.2.1
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.2.1/; s/^API_RELEASE=.*/API_RELEASE=1.2.1/' deploy/.env
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build

# Later, to go forward again
git checkout main && git pull
```

- [ ] **With GitHub's images instead**: in `deploy/.env` set `API_IMAGE` and `WEB_IMAGE` back to the release you were on before the update (GitHub → your profile → **Packages** → `integr8-api` lists every release's tag, for example `ghcr.io/minalouisleon/integr8-api:v1.2.2`), and `APP_VERSION`/`API_RELEASE` to its number. Then `pull` and `up -d`; no `git checkout` is needed, the images carry the code. To go forward again, the newer tag, `pull` and `up -d`. Releases before v1.2.2 have no images: go back to one of those by building, with the commands above, after putting `#` in front of both lines.
- [ ] **The older version is running.** The `migrate` log ends with "the database is ahead of this build" and the new migrations' names, and part E's checks pass. Going forward again later applies nothing: the migrations are already there.
- [ ] **Undoing one migration**, only when the release notes or the error say it is the cause, after reading its `.down.sql` file in `packages/db/migrations/`. Do it **before** going back, while the new version still runs, because only its image has that file: `docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node node_modules/@integr8/db/dist/migrator/cli.js down --steps 1`. The older version refuses to undo a migration it has no file for.
- [ ] **Restoring part B's backup** replaces the whole database with how it was before the update, losing anything done since. Stop the web app, the API, the worker and the sign-in server first (`docker compose … stop web api worker auth`), restore with the command at the top of `deploy/vps/backup-postgres.sh` (the backup replaces each table as it goes, so nothing has to be emptied first), then start the older version as above.

### J. AI assistant (included in v1.1.2)

The AI assistant, help-library answers, provider integrations and voice are included in the v1.1.2 release. If your server or installed apps predate these features, use the normal Stage 11 release process to update them; do not make a separate 1.2.0 release just for the assistant. Keep provider settings optional until you choose to enable AI, then follow Stages 3, 5 and 7.

- [ ] **Machine configuration:** on upgrade, use the Stage 11 env-template comparison to add any missing `AI_` settings. They are optional; leave AI disabled until configured. Migrations run as part of the standard update and preserve existing data.
- [ ] **Nothing changes for any company yet**: every plan's AI level is Off, every company's app switches are off, and nobody has a share. Switching it on is Stage 5 (the AI provider panel and each plan) and then Stage 7's AI part for each company. For AI answers, tell each company's owner before you switch their plan on that they will be asked to hand out shares under Settings → People, or set the shares for them from the dashboard; for help-library answers there is nothing for them to do.
- [ ] **Update the apps** (part G): install the current staff release (v1.1.2 or later) and distribute each company's current desktop and phone builds. Older phone builds may need reinstalling to include native voice support (Stage 8, step 7).

> [!WARNING]
> **Rolling back with the assistant.** To switch the assistant off without touching the code: `AI_ENABLED=false` in `deploy/.env` and `up -d`; every company loses it at once and nothing else changes. To change provider: set `AI_PROVIDER` to the other one (`openai`, `groq`, `gemini`, `anthropic`) with its own key, model and price lines (Stage 3), then `up -d`. To drop AI but keep a working assistant: `AI_PROVIDER=none` and `up -d`; every company gets help-library answers. To go back to the previous code (part I): leave migrations 0044 to 0047 applied, because the older version ignores their tables, and undoing 0046 would lose every person's share and the token counts. Its `.down.sql` file is for development databases only.

### K. PDF documents (included in v1.1.2)

PDF document generation and templates are included in v1.1.2. Older installations receive them through the standard Stage 11 update; no separate 1.3.0 release is needed.

- [ ] **Machine configuration:** use Stage 11's template comparison to add `PDF_RENDERER=chromium` if missing. The API image includes Chromium and fonts, and the migration runs during the standard update. Afterward check Stage 4's worker line: `PDF documents can be printed`.
- [ ] **Nothing changes for any company yet**: `documents` is off for every company until you switch it on under **Features** and design its templates (Stage 7).
- [ ] **Update the apps** (part G): install the current staff app to design templates, and distribute current company desktop and phone builds to users who need Documents.

> [!WARNING]
> **Rolling back with PDF documents.** To stop new PDFs without touching the code, switch `documents` off for the company: its menus and its QR code pages close at once, and nothing is deleted. To go back to the previous code (part I): leave migration 0048 applied, because the older version ignores its tables; its `.down.sql` deletes every document and template and is for development databases only.

### L. E-invoicing (included in v1.1.2)

ETA e-invoicing is included in v1.1.2. Older installations receive it through the standard Stage 11 update. Keep it disabled until the ETA test-system workflow has been validated; production remains disabled.

- [ ] **The e-invoicing key, when you are ready for it**: make it with Stage 0, Part B, and add it to the key sheet as `ETA_CREDENTIALS_KEY`. Until e-invoicing is switched on for a company it can stay blank.
- [ ] **Machine configuration:** use Stage 11's template comparison to add `ETA_CREDENTIALS_KEY=` if you will use e-invoicing. It may stay blank until then; keep `ETA_ALLOW_PRODUCTION=false`. The migration runs during the standard update.
- [ ] **Nothing changes for any company yet**: `e_invoicing` is off for every company until you switch it on, in the staff desktop app's **E-invoicing switch** or under **Features** (Stage 7). Leave it off until e-invoicing has been tested, and leave production off.
- [ ] **Update the apps** (part G): distribute the current staff desktop app, which contains the signing queue, to staff who will test e-invoicing.

> [!WARNING]
> **Rolling back with e-invoicing.** To stop it without touching the code, switch `e_invoicing` off for the company (staff desktop app, **E-invoicing switch**, or **Features**): its menus close at once, and nothing is deleted. To go back to the previous code (part I): leave migration 0049 applied, because the older version ignores its tables; its `.down.sql` deletes every company's ETA settings, credentials and the record of every document sent, and is for development databases only.

### M. Company website data API (included in v1.2.0)

The website data API is included in v1.2.0 and adds migration 0050. It needs no new server environment variable. Configure `INTEGR8_API_URL` and `INTEGR8_WEBSITE_KEY` only in the company's Next.js/Vercel server environment, as described in `docs/documents/WEBSITE-LOOKUP.md`.

- [ ] **Migration 0050 applied** during the normal update. It adds four company website switches and a reversible enabled state to website keys. Do not run its down migration on a production database.
- [ ] **All company capabilities start off.** Integr8 must switch on the matching `website_*` flag and the company owner/admin must switch on the corresponding Customer website access control. A key alone does not enable a capability.
- [ ] **Confirm key lifecycle and rollback.** Any Integr8 staff can create, enable, disable or revoke keys. Revocation stops the service and retains the audit record; only the terminal-created staff admin can permanently delete a key. Before rolling back to code that predates this feature, revoke website keys or turn off website access; older code does not enforce the new disabled state or the two switch layers. Keep migration 0050 applied.
- [ ] **Update the website integrations** using `apps/api/openapi.json`; keep the key server-side and verify each enabled endpoint from the company's Vercel deployment.

### N. The schedule (included in v1.2.1)

The schedule adds migration 0051 and needs no new server setting. It ships in v1.2.1.

- [ ] **Migration 0051 applied** during the normal update. It adds the job visits tables and installs the `btree_gist` Postgres extension, which is what stops anyone being booked on two jobs at once. The migration installs it by itself on the machine's Postgres. Do not run its down migration on a production database: it deletes every visit.
- [ ] **Existing jobs are unchanged.** They have no visits yet, so they wait under **Needs a visit** until someone plans one, and the phones show them as before.
- [ ] **Update the apps** (part G): the schedule is in the new desktop apps and the visit timeline in the new phone builds. An older phone keeps working; it just does not show visits.

> [!WARNING]
> **Rolling back with the schedule.** Fix forward rather than going back to the previous code once visits have been planned: an older version does not know the new history entries, so a job with visit history would not open in it. If you must roll back (part I), leave migration 0051 applied; its `.down.sql` deletes every visit and is for development databases only.

### O. Skills and certificates (included in v1.2.1)

Skills and certificates add migration 0052 and need no new server setting. They ship in v1.2.1.

- [ ] **Migration 0052 applied** during the normal update. It adds the qualifications tables and a warning period for each company (30 days). Nothing changes for planning until a company records qualifications and says what its job types need.
- [ ] **Expiry alerts.** The worker sends them once a day, once per certificate: to the holder by email and on their phone, and one email to the owners, admins and HR managers. They use the email sender from part F and link to `WEB_APP_URL`; without a sender they are only logged. After the first certificate falls within its warning period, the worker log says **Qualification expiry finished**.
- [ ] **Update the apps** (part G) before companies record requirements: the new desktop apps have **Skills and certificates** and ask for a reason when nobody on a visit is qualified, and the new phone builds have **My qualifications**. An older desktop app cannot give a reason, so it cannot plan a visit nobody is qualified for; an older phone keeps working without the new screen.

> [!WARNING]
> **Rolling back with skills and certificates.** Fix forward once a visit has gone ahead with a reason: an older version does not know that history entry, so the job would not open in it. If you must roll back (part I), leave migration 0052 applied; its `.down.sql` deletes every qualification record and is for development databases only.

### P. Contracts, maintenance and deadlines (included in v1.2.1)

Contracts, maintenance plans and deadlines add migration 0053 and need no new server setting. They ship in v1.2.1.

- [ ] **Migration 0053 applied** during the normal update. It adds service contracts, maintenance plans and response deadlines. Nothing changes for a company until it sets deadlines, adds a contract or adds a maintenance plan; existing jobs keep no deadlines and no coverage.
- [ ] **The worker's new runs.** Once a day it makes the jobs maintenance plans are due to make and emails contract managers before a contract ends; every ten minutes it records missed deadlines and sends deadline warnings by email and to engineers' phones. They use the email sender from part F and link to `WEB_APP_URL`; without a sender they are only logged. The worker log says **Maintenance plans finished** and **Deadline alerts finished** when they had something to do.
- [ ] **Certificate expiry alerts start.** Migration 0052 left out the line the daily certificate expiry run needs to take its turn, so no expiry alert was sent before this update. 0053 adds it: the first run after the update sends every warning that is due at once.
- [ ] **Update the apps** (part G): the new desktop apps have **Contracts**, **Maintenance** and **Deadlines**, and the new phone builds show coverage, deadlines and planned maintenance on each job. An older app keeps working without them.

> [!WARNING]
> **Rolling back with contracts, plans and deadlines.** Fix forward once a plan has made a job or a deadline has been missed: an older version does not know those history entries, so the job would not open in it. If you must roll back (part I), leave migration 0053 applied; its `.down.sql` deletes every contract, plan and deadline and is for development databases only.

### Q. Self-hosted sign-in (included in v1.2.2)

Sign-in moves from Supabase's cloud to a Supabase Auth container on this machine, beside the API. The update adds migrations 0054 to 0057, the `auth` container and three settings, and new screens in every app: **Email me a sign-in code** for a forgotten password, and **Change password**. The Supabase cloud project is no longer used. Nobody has an account yet, so nothing is moved: sign-in simply starts on the new server.

- [ ] **The three sign-in secrets.** On the laptop, run Stage 0, Part B's key generator again and keep only its last three lines (`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_AUTH_DB_PASSWORD`) in the key sheet and the password manager. Its first four lines are new signing keys you do **not** want: the machine keeps its own.
- [ ] **The env file**, during part C with `nano deploy/.env`: delete the `SUPABASE_URL=` line (the API refuses to start while it is there), put the new `SUPABASE_SERVICE_ROLE_KEY=` line in place of the old one, and add the other two lines beside it. Part C's `comm` check then prints none of the three.
- [ ] **Migrations 0054 to 0057 applied** during part D. 0054 records how each session was signed in, which Change password needs, and adds the list of sign-in accounts still to delete after a company is purged. 0055 lets a closed company be purged at all: before it, any company that had published a form could not be. 0056 clears the file retention windows the plans shipped with, so no plan deletes a company's photos and documents on its own. 0057 starts new companies on Cairo time with a Sunday-to-Thursday week; a company that already exists keeps what it has, so check its timezone and working days in Settings → Company. Do not run their down migrations on a production database.
- [ ] **The `auth` container comes up** in part D: `bootstrap` creates its database role and schema, `auth` sets up its own tables and turns healthy, and only then do the API and worker start. In part E, `auth` is _Up (healthy)_, and `sudo ss -tlnp | grep -E ':(3000|3001)\b'` shows the API and web ports on `127.0.0.1` only; Caddy still reaches them.
- [ ] **Try it.** In the web app, sign out, type an invited address and choose **Email me a sign-in code**; the code arrives by email within a minute. Sign in with it, open **Change password** from the menu (it asks for no current password for fifteen minutes after a code), and set a new one. Another browser or phone signed in as the same person is signed out, and the address gets "Your password was changed".
- [ ] **A password reset from the server**, for somebody who cannot receive the emailed code: `admin-cli user-password` gives their address a new password in the sign-in server, prints it once, and signs out their devices. Send it privately; they sign in with it and choose **Change password**. Staff accounts are unchanged: `admin-cli create` as in Stage 5.
- [ ] **Update the apps** (part G): the two new screens are in the new staff app and in each company's new desktop installer and phone build. An older app keeps signing in with a password; it just has neither screen.

```bash
# machine (SSH session), from /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js user-password someone@example.com
```

> [!WARNING]
> **Rolling back with self-hosted sign-in.** A version before this one signs in through a Supabase cloud project, which does not have the accounts made since. Fix forward instead. If you must roll back (part I), put `SUPABASE_URL` and the cloud project's service role key back in `deploy/.env` first, and leave migrations 0054 to 0057 applied: the older version ignores their columns and table. v1.2.1 is older than part I's ahead-of-build check, so its `migrate` step stops at 0054 ("its file is gone") and its API and worker would never start. After part I's `git checkout v1.2.1` and `sed`, start them without that step: `docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build --no-deps api worker web` (v1.2.1 has no GitHub images, so it is always built: if `deploy/.env` names `API_IMAGE` and `WEB_IMAGE`, put `#` in front of both lines first). Until you go forward again, its `/health/ready` says `degraded` and names 0054 to 0057, so the uptime check alerts; the API answers requests all the same.

### R. Backups off the machine, and the restore drill (included in v1.2.2)

The backup script can now copy each night's dump off the machine to an encrypted R2 bucket, and a new script rehearses a restore without touching the live database. Nothing changes until you set them up: the three new settings (`BACKUP_REMOTE`, `BACKUP_REMOTE_KEEP`, `BACKUP_PING_URL`) are optional and commented out in `deploy/.env.example`, so part C's check does not list them.

- [ ] **Set up the copy** on a machine that went live before it existed: Stage 9, part B, from "A bucket for the copies" to "A boot-volume backup policy as well". Until then every night's log ends with "backups are on this machine only".
- [ ] **Run the restore drill** (Stage 9, part B, "Rehearse a restore") and add its row to the rehearsal log in `docs/database/runbook-backup-and-restore.md`.

### S. The phone app: offline access, notifications and crash reports (included in v1.2.2)

Phones now open with no signal only on a signed offline grant that ends seven days after they last reached the API, checked on the phone, instead of on their thirty-day sign-in. Engineers can add notes and correct access notes from a job, Today shows the company's announcements, and Android notifications and the phone's crash reports get the settings they were missing. The server needs nothing new: the API sends the grant by itself.

- [ ] **Expo's build settings and Firebase**, as in Stage 8, part A, with Stage 0's parts I and J first if the React Native Sentry project and the Firebase project do not exist yet: the three environment variables, every switched-on company added to Firebase with the new `google-services.json` uploaded, and the FCM key chosen for each company's application identifier.
- [ ] **Rebuild every company's phone app** (Stage 8, **Build company apps** with company `all`, or the version release) and send each company the new `.apk`. The Firebase file is part of the build, so notifications on Android need it. Until a phone has the new app it keeps working as before, opening with no signal on its sign-in for up to thirty days.
- [ ] **Check one phone.** Sign in, then put it in aeroplane mode: it opens on its jobs. Add a note and correct a gate code; both show at once, and reach the web when signal returns. A notification arrives for a new job. Sentry's React Native project lists the phone's release, and shows no `offline-grant` warning from it.

> [!NOTE]
> **The test box (Stage 10)** updates the same way, from `staging` instead of `main`: `git pull` on its `staging` checkout, then **Pull** and **Redeploy** the stack in Arcane. Updating it first, the day before, is the cheapest rehearsal there is.

---

## Stage 12 — Wipe the machine and start fresh

_about 15 minutes, then Stages 4 to 8 again · optional_

This removes everything Integr8 put on the Oracle machine: the containers, the images, the database and its data, the uploaded files kept on disk, and the repository folder. Then it clones the latest version and starts again from Stage 4. Use it when the machine is in a state you no longer trust, or to test a release from nothing. It is **not** how you update: Stage 11 updates and keeps every company and its data.

> [!WARNING]
> **Everything in the database is deleted and cannot be brought back**: every company, person, job, form and submission, and the super admin. Only a backup you copy off the machine first (step A2) survives. The machine itself, Caddy, the firewall, your domain and every account and key from Stage 0 stay as they are, so none of Stages 0 to 3 needs doing again.

### A. Keep what you will need again

- [ ] **Keep the env file.** Stage 3 took half an hour; the copy below saves it. It goes to your home folder, outside the folder that is about to be deleted.

```powershell
# laptop (PowerShell)
ssh LOGIN-USER@SERVER-IP
```

```bash
# machine (SSH session)
cp /opt/integr8/deploy/.env ~/integr8.env.keep
chmod 600 ~/integr8.env.keep
ls -l ~/integr8.env.keep        # one file, a few kilobytes
```

- [ ] **A last backup, if anything in it matters.** Skip this for a test machine with nothing worth keeping. Otherwise make one more database dump and copy it to your laptop, because the machine's backup folder is emptied in step C.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lt /var/backups/integr8 | head -3   # the newest file is the one just made
```

```powershell
# laptop (PowerShell): copies every dump into your Downloads folder
scp "LOGIN-USER@SERVER-IP:/var/backups/integr8/*.sql.gz" $env:USERPROFILE\Downloads\
```

### B. Remove the stack and everything Docker holds

- [ ] **Stop and delete the stack** with its containers, its network, its two volumes (`postgres-data`, the database; `media-local`, files kept on disk when R2 is off) and the images it built or pulled. The second command then clears what is left over: old image versions from earlier updates and the build cache, which on this machine is often several gigabytes.

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env down --volumes --remove-orphans --rmi all
docker system prune --all --volumes --force
cd ~
```

- [ ] **Check it is empty.** All three lists below should show only their header line, and the last command shows the space Docker still uses: zeros, or close to it.

```bash
# machine (SSH session)
docker ps -a
docker volume ls
docker images
docker system df
```

> [!NOTE]
> **Something still listed?** A container that was started outside this compose file (a test you ran by hand) is not removed by `down`. Remove the leftovers by name: `docker rm -f NAME`, `docker volume rm NAME`, `docker rmi IMAGE`, then run the checks again. `docker system prune --all --volumes` deletes every unused image and volume on the machine, not only Integr8's; on a machine that runs nothing else, that is what you want.

### C. Delete the repository and the backups

- [ ] **Delete the folder, the nightly backup job and the old backups.** The first line removes `/opt/integr8`, including the old `deploy/.env` (your copy is in your home folder). The second takes the backup line out of the crontab from Stage 9 so it does not fail every night against a folder that is gone; it prints nothing if the line was never added. The last two delete the backups and their log, so do them only after step A2 if you wanted a copy.

```bash
# machine (SSH session)
sudo rm -rf /opt/integr8
crontab -l 2>/dev/null | grep -v backup-postgres.sh | crontab -
sudo rm -rf /var/backups/integr8
sudo rm -f /var/log/integr8-backup.log
ls /opt                       # integr8 is no longer listed
```

### D. Only if Docker itself is broken: remove and reinstall it

Usually not needed: steps B and C leave Docker installed, empty and working. Do this only if `docker` commands hang or fail on their own, or you want the engine itself fresh. Run the block for your operating system; the setup script from Stage 1 then installs it again, and leaves Caddy, the firewall and automatic updates as they are because they are already done.

```bash
# machine (SSH session), Ubuntu
sudo systemctl stop docker docker.socket containerd
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
sudo apt-get autoremove -y
sudo rm -rf /var/lib/docker /var/lib/containerd /etc/docker
```

```bash
# machine (SSH session), Oracle Linux
sudo systemctl stop docker docker.socket containerd
sudo dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
sudo rm -rf /var/lib/docker /var/lib/containerd /etc/docker
```

```bash
# machine (SSH session), either system: install Docker again
curl -fsSL https://raw.githubusercontent.com/MinaLouisLeon/integr8-plus/main/deploy/vps/setup.sh | bash
exit            # log in again so docker works without sudo
```

### E. Outside the machine

Some of what the old installation created lives in other services, not on the machine. None of it stops the fresh start; tidy it so names and addresses can be used again.

- [ ] **Sign-in accounts went with the database.** They live in the `auth` schema of the same database, so step B deleted them with everything else. Nothing to tidy.
- [ ] **Your authenticator app.** Delete the old **Integr8 Plus** entry; Stage 5 gives you a new one for the new super admin.
- [ ] **Cloudflare R2: the old companies' buckets.** Each company had a bucket named `integr8-staging-…` or `integr8-production-…` followed by its id. Nothing points at them any more and they keep their files (and a little cost). Cloudflare → **R2** → each old bucket → **Settings** → **Delete bucket** (Cloudflare asks you to empty it first: open it, select all objects, delete). New companies get new buckets automatically.
- [ ] **Stripe test data, if you tried in-app payment.** Test-mode customers and subscriptions from the old companies are harmless. To clear them: Stripe (test mode) → **Developers** → **Overview** → **Delete all test data**. Your products, prices and webhook are kept only if you do **not** do this; if you do, re-create them as in Stage 0, Part G, and put the new price IDs into Stage 5.
- [ ] **Nothing to do** for GitHub (the repository, its releases, variables and secrets), Expo, Resend, Mapbox, Sentry, your domain, DNS and Caddy. They are all still right.

### F. Start again on the latest version

- [ ] **Clone the latest `main` and put your env file back.** The same clone as Stage 1, then your kept copy becomes `deploy/.env` again.

```bash
# machine (SSH session)
docker compose version
sudo mkdir -p /opt/integr8 && sudo chown "$USER" /opt/integr8
git clone https://github.com/MinaLouisLeon/integr8-plus.git /opt/integr8
cd /opt/integr8
cp ~/integr8.env.keep deploy/.env
chmod 600 deploy/.env
```

- [ ] **Look for settings the new version added.** The command lists every setting in the new template that your kept file does not have. Nothing printed means nothing to add. Anything printed (for example `HR_DATA_KEY=`, added with the HR module, or the `AI_` lines of the assistant) goes into `deploy/.env` with `nano deploy/.env`, with its value from the key sheet; the template's comments beside each line say what it is.

```bash
# machine (SSH session), in /opt/integr8
comm -23 <(grep -oE '^#? ?[A-Z][A-Z0-9_]+=' deploy/.env.example | tr -d '# ' | sort -u) \
         <(grep -oE '^#? ?[A-Z][A-Z0-9_]+=' deploy/.env | tr -d '# ' | sort -u)
```

- [ ] **Start the stack: Stage 4**, exactly as written. Postgres starts empty, `bootstrap` creates the database roles, the sign-in server's included, with the passwords from your env file, and every migration is applied from the first. Then the same checks as Stage 4.
- [ ] **Then Stages 5, 7 and 8**: a new super admin and the plans' Stripe prices, then each company onboarded again with its forms, job types and look, then its apps built. Stage 6 needs nothing: the staff desktop app on your laptop still works and simply signs in to the fresh installation. Already-installed company apps keep working too once their company is onboarded again with the **same short name**; with a different short name, build and install them again (Stage 8).
- [ ] **Delete the kept copy** once the stack is up and you have signed in: `rm ~/integr8.env.keep`. It holds every secret the stack has; the password manager is where it belongs.

---

## Stage 13 — Destroy the Oracle machine, or empty it and keep it

_about 3 hours, mostly Stages 1 to 4_

Stage 12 empties the machine and keeps it. This stage deletes the machine itself, its disk included, and makes a new one: a new operating system, a new shape, or simply a clean start on the current release (v1.2.2). Everything from Stage 0 lives outside the machine and carries over unchanged: the domain and Cloudflare, R2, Resend, Stripe, Mapbox, Sentry, Expo and every GitHub variable and secret. What dies with the machine is what was only on its disk: `deploy/.env`, the database, the backups in `/var/backups/integr8`, and the Caddy file. Part A saves the first two if you want them.

> [!NOTE]
> **Two ways to start over.** Parts B to E delete the Oracle machine itself and make a new one. [Part F](#f-keep-the-machine-but-remove-everything-on-it-data-docker-and-the-repository) keeps the machine, its address, its firewall and your login, and removes only what Integr8 put on it: the data, Docker and the repository. Do part A first either way; then choose.

> [!WARNING]
> **From the moment the old machine stops until part D finishes, the web app and the API are down.** Phones keep working offline and send their work when the API is back. Pick a quiet day and tell anybody using it.

### A. Before you destroy it: keep what you will need

- [ ] **Copy the env file to the laptop** and put it in your password manager too. It holds every key from the key sheet, the database passwords and `HR_DATA_KEY`; with it, Stage 3 is a two-minute copy instead of half an hour.

```powershell
# laptop (PowerShell)
scp LOGIN-USER@SERVER-IP:/opt/integr8/deploy/.env $env:USERPROFILE\Documents\integr8.env
Get-Content $env:USERPROFILE\Documents\integr8.env | Select-String 'HR_DATA_KEY|APP_VERSION'
```

- [ ] **If the copy has no `HR_DATA_KEY`** (the old machine ran a version from before the HR module), generate one now with Stage 0, Part B and add it to the key sheet. If it has one, keep exactly that value.
- [ ] **Decide: keep the data, or start empty.** Keeping it means every company, person, job and document comes back on the new machine as it was. Starting empty means onboarding companies again (Stage 7). For keeping it, make one last dump and copy it off the machine, because the backups on its disk are deleted with it:

```bash
# machine (SSH session) — only if you keep the data
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env stop auth api worker web   # nothing changes after the dump
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lt /var/backups/integr8 | head -3     # the newest file is the one just made
```

```powershell
# laptop (PowerShell): every dump into your Downloads folder
scp "LOGIN-USER@SERVER-IP:/var/backups/integr8/*.sql.gz" $env:USERPROFILE\Downloads\
```

- [ ] **The dump is on the laptop**, a few megabytes or more, with today's date in its name. Keep it with `HR_DATA_KEY`: one is not readable in full without the other.
- [ ] **Check the address is reserved.** Oracle → Networking → IP Management → **Reserved public IPs**: the machine's address should be listed (Stage 1 reserved it). A reserved address survives the machine, so the two DNS records stay right. If it is not listed, the new machine gets a new address and part D changes the two DNS records.

### B. Destroy the machine

- [ ] **Terminate the instance.** Oracle → Compute → Instances → `integr8` → **More actions** → **Terminate**, tick **Permanently delete the attached boot volume**, confirm. In a few minutes it is gone. The reserved address returns to the list, unassigned. Leave the virtual cloud network, its subnet and its security list (with the 80 and 443 rules) where they are: the new machine reuses them.
- [ ] **Old boot-volume backups** (Block Storage → Boot volume backups) from Stage 9 belong to the deleted disk. Delete them once the new machine runs, so they stop counting against the five free backups.
- [ ] **Only if you start empty**, tidy what lives outside the machine: Stage 12, part E (old companies' R2 buckets, Stripe test data). If you keep the data, touch nothing outside the machine: the restored database still points at every one of them.

### C. The new machine: Stages 1 and 2 again

- [ ] **Stage 1, with two differences.** Under Networking choose **Select existing virtual cloud network** and its public subnet instead of creating new ones; the security list already lets 80 and 443 in. Once the instance is Running, give it the reserved address: the instance's VNIC → **IPv4 Addresses** → Edit → **No public IP** → Update, then Edit again → **Reserved public IP** → the kept address → Update. Then the setup script, the second SSH login and the clone, as written.
- [ ] **The laptop will refuse to connect at first**, with "REMOTE HOST IDENTIFICATION HAS CHANGED": the address is the same, the machine behind it is new. That is expected here and only here. Forget the old machine's fingerprint and connect again:

```powershell
# laptop (PowerShell)
ssh-keygen -R SERVER-IP
ssh LOGIN-USER@SERVER-IP          # yes to the new fingerprint
```

- [ ] **Stage 2**: the Caddy file again (copy, `sed`, reload), exactly as written. The DNS records need nothing if the address was reserved; otherwise edit the two A records in Cloudflare to the new address and wait for `nslookup` to show it. Both padlocks appear as before.

### D. Settings, data and the stack

- [ ] **Put the env file back** from the laptop, then look for settings version 1.2.2 knows about that the kept file lacks, and set the version.

```powershell
# laptop (PowerShell)
scp $env:USERPROFILE\Documents\integr8.env LOGIN-USER@SERVER-IP:/opt/integr8/deploy/.env
```

```bash
# machine (SSH session)
cd /opt/integr8
chmod 600 deploy/.env
comm -23 <(grep -oE '^#? ?[A-Z][A-Z0-9_]+=' deploy/.env.example | tr -d '# ' | sort -u) \
         <(grep -oE '^#? ?[A-Z][A-Z0-9_]+=' deploy/.env | tr -d '# ' | sort -u)
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.2.2/; s/^API_RELEASE=.*/API_RELEASE=1.2.2/' deploy/.env
grep -E '^(APP_VERSION|API_RELEASE|HR_DATA_KEY)=' deploy/.env
```

- [ ] **Every name the `comm` command printed is added** with `nano deploy/.env`, its value from the key sheet (the template's comment beside each line says what it is). `HR_DATA_KEY` is the one most likely to be missing. The last command shows the version as `1.2.2` and the HR key filled in.
- [ ] **Starting empty?** Run Stage 4 exactly as written and go on to part E. **Keeping the data?** Do the next step instead of Stage 4's first command.
- [ ] **Restore the dump into the new database**, before the migrations run: start only Postgres and the step that creates the database roles, load the dump, then start everything. The migrations then apply any schema additions the restored database does not yet have.

```powershell
# laptop (PowerShell): the dump goes to the machine (use the real file name)
scp $env:USERPROFILE\Downloads\integr8-20261013-0300.sql.gz LOGIN-USER@SERVER-IP:~/
```

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build bootstrap   # Postgres and the roles only
docker compose -f deploy/compose.yml --env-file deploy/.env ps                         # bootstrap: Exited (0)
gunzip -c ~/integr8-20261013-0300.sql.gz \
  | docker compose -f deploy/compose.yml --env-file deploy/.env exec -T postgres psql -U postgres -d integr8 -v ON_ERROR_STOP=1
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build              # migrate, auth, api, worker, web
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
rm ~/integr8-20261013-0300.sql.gz
```

- [ ] **The stack is up**: Stage 4's checks (`/health/ready` says `ready`, the web app shows its padlock, the bucket check finishes). The storage check matters after a restore: it confirms every restored company's R2 bucket is still reachable.

### E. Back in business

- [ ] **With the data kept**: sign in to the dashboard with your usual super admin and authenticator (they came back with the database, and `PLATFORM_SECRET_KEY` is unchanged); Health is empty; open a company, one of its jobs and, in HR, one employee's profile (the national ID shows, so `HR_DATA_KEY` is right). Every installed app, staff and company, keeps working: the address they call has not changed. On a phone, pull to sync; anything queued while the machine was down arrives now.
- [ ] **Starting empty**: Stage 5 (a new super admin, the plans' Stripe prices, your colleagues), then Stage 7 for each company (onboard, switch on its modules, forms, look, invite), then Stage 8 for its apps. The staff desktop app already installed simply signs in to the new installation. A company onboarded again with the **same short name** keeps its installed apps; with a new short name, build and install them again.
- [ ] **Install the current staff app** if your laptop still has an older one: Stage 6, second step.
- [ ] **The safety net again**, because it was on the old disk: the nightly backup line in `sudo crontab -e`, rclone and its two remotes with the same backup passphrase, and a boot-volume backup policy on the new boot volume (Stage 9, part B); a reboot test (Stage 9, part C). The uptime monitor needs nothing: it watches the same address.
- [ ] **Clean up the copies** once everything is checked: delete `integr8.env` from Documents (the password manager has it) and keep the dump only as long as your backup policy says.

### F. Keep the machine, but remove everything on it: data, Docker and the repository

The machine stays: the Oracle instance, its boot volume, its reserved address, your SSH login, the operating system and both firewalls. What goes is everything Integr8 put there: the containers, the database and all its data, the files kept on disk, every image and volume, the Docker engine itself, the repository folder, the settings file, the backups and their nightly job. Afterwards it is a clean machine again, ready for Stage 1's setup script and a fresh clone. About 15 minutes.

> [!WARNING]
> **This cannot be undone.** Every company, person, job, form and document on this machine is deleted with the database. Do part A first: the settings file and a last database dump on your laptop are the only way back. Two commands below (`docker system prune --all --volumes` and the Docker removal) delete **everything Docker holds on this machine, not only Integr8's**; do not run them if anything else lives here.

#### F1. Stop and delete the stack and everything Docker holds

- [ ] **Take the stack down** with its containers, network, its two volumes (`postgres-data`, the database; `media-local`, uploaded files kept on disk when R2 is off) and the images it built or pulled. The second command then removes what is left over: old images from earlier updates, any other volume, and the build cache (often several gigabytes).

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env down --volumes --remove-orphans --rmi all
docker system prune --all --volumes --force
docker builder prune --all --force
```

- [ ] **Remove anything started by hand.** A container run outside this compose file (a test, a one-off `docker run`) is not touched by `down`, and one still running keeps its image and volumes alive. Remove them all, then check that every list is empty and Docker uses almost nothing:

```bash
# machine (SSH session)
docker ps -aq | xargs -r docker rm -f
docker volume ls -q | xargs -r docker volume rm -f
docker network prune --force
docker ps -a ; docker volume ls ; docker images ; docker system df
```

#### F2. Delete the repository, the settings, the backups and the jobs that used them

- [ ] **The repository and the settings file.** `/opt/integr8` holds the code, `deploy/.env` (every secret) and nothing else you need once part A's copy is on your laptop. Also delete any copy of the settings or a dump left in your home folder.
- [ ] **The nightly backup and the backups themselves.** The first line takes the backup job out of the crontab (it prints nothing if it was never added); the rest delete the dump files, their log and rclone's settings, which hold the R2 backup token and the backup passphrase. The copies already in the `integr8-backups` bucket stay until you delete them in Cloudflare. Do these only after part A's dump is safe on your laptop.

```bash
# machine (SSH session)
cd ~
sudo rm -rf /opt/integr8
rm -f ~/integr8.env.keep ~/integr8*.sql.gz ~/*.sql.gz
crontab -l 2>/dev/null | grep -v backup-postgres.sh | crontab -
sudo crontab -l 2>/dev/null | grep -v backup-postgres.sh | sudo crontab -
sudo rm -rf /var/backups/integr8
sudo rm -f /var/log/integr8-backup.log
sudo rm -rf /root/.config/rclone
ls /opt ; ls /var/backups
```

#### F3. Remove Docker itself

This takes out the engine, its Compose and Buildx plug-ins, its package source and key, and the folders where it kept images and volumes. Run the block for your operating system (`cat /etc/os-release` says which). Stage 1's setup script installs Docker again later.

```bash
# machine (SSH session), Ubuntu or Debian
sudo systemctl disable --now docker docker.socket containerd 2>/dev/null
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
sudo apt-get autoremove -y --purge
sudo rm -rf /var/lib/docker /var/lib/containerd /etc/docker
sudo rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg /usr/share/keyrings/docker-archive-keyring.gpg
sudo apt-get update
```

```bash
# machine (SSH session), Oracle Linux, RHEL, Rocky or AlmaLinux
sudo systemctl disable --now docker docker.socket containerd 2>/dev/null
sudo dnf remove -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
sudo rm -rf /var/lib/docker /var/lib/containerd /etc/docker
sudo rm -f /etc/yum.repos.d/docker-ce.repo
sudo dnf clean all
```

- [ ] **Docker is gone.** `docker --version` says "command not found", and `ls /var/lib/docker` says there is no such folder.

#### F4. Caddy and logs: your choice

- [ ] **Caddy.** It holds no Integr8 data, only the two names in `/etc/caddy/Caddyfile` and the certificates it fetched. Either **leave it** (it keeps answering with an error page on both names until a new stack is up, and the certificates stay valid), or **reset it** so it no longer mentions Integr8, or **remove it** too:

```bash
# machine (SSH session), reset: Caddy keeps running with a blank page
echo ':80 { respond "Caddy is running" }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy

# or remove it entirely (Ubuntu or Debian)
sudo systemctl disable --now caddy
sudo apt-get purge -y caddy 2>/dev/null ; sudo rm -f /usr/bin/caddy /etc/systemd/system/caddy.service
sudo rm -rf /etc/caddy /var/lib/caddy
# on Oracle Linux use: sudo dnf remove -y caddy
```

- [ ] **Free the last space.** Old system logs and package files can hold a surprising amount after months of container logs:

```bash
# machine (SSH session)
sudo journalctl --vacuum-size=50M
sudo apt-get clean 2>/dev/null ; sudo dnf clean all 2>/dev/null
df -h /
```

#### F5. Check it is empty

```bash
# machine (SSH session)
ls /opt                                   # integr8 is not listed
crontab -l 2>&1 | head -3 ; sudo crontab -l 2>&1 | head -3   # no backup-postgres.sh line
ls /var/backups                           # no integr8 folder
command -v docker || echo "docker: not installed"
sudo ss -tlnp | grep -E ':(80|443|3000|3001|5432)\b' || echo "nothing listening on the app ports"
df -h /                                   # most of the disk is free again
```

- [ ] **All six answers are as written.** If port 80 or 443 still shows a listener it is Caddy (left in place on purpose) or something you installed yourself. Ports 3000, 3001 and 5432 must show nothing.

#### F6. What was kept, and how to use the machine again

| Kept                                                                  | Removed                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The Oracle instance, its boot volume and its reserved address         | The database and every company's data on it                       |
| Your SSH key and login; the operating system and its security updates | All containers, images and volumes, and the Docker engine         |
| The firewall rules for 80 and 443, and Oracle's security list         | `/opt/integr8`, `deploy/.env` and every copy of it on the machine |
| Caddy and its certificates (unless you removed it in F4)              | The backups, the nightly backup job and its log                   |
| The DNS records, R2, Stripe, Resend, GitHub and every other account   | Files kept on disk (uploads when R2 is off)                       |

- [ ] **To use the machine again**, run Stage 1 from "Connect and run the setup script" (it installs Docker again and re-checks the firewall and Caddy), clone the repository, then continue with part D of this stage: the settings file back, the dump restored if you are keeping the data, the stack started.
- [ ] **Outside the machine** nothing changed. If you start empty rather than restoring, tidy the old companies' R2 buckets and Stripe test data as Stage 12, part E describes; if you restore, leave them alone.

---

## Stage 14 — A demo company full of test data

_about 20 minutes_

One command on the machine creates a new company, **Nile Delta Facilities (Demo)**, and fills every section of it, so you can test the screens without typing anything in first. It is onboarded the way the dashboard onboards a real company (Enterprise plan, invoiced, its own storage bucket), every module is switched on, and it gets nine people: you as the owner, plus an admin, an HR manager, an inventory manager, a dispatcher, three engineers and a viewer. Then it fills the company through the API, as those people: settings, roles and certificates; customers, contacts and sites; suppliers, stock items, a warehouse and three vans; purchase orders and receipts; bills of materials and assembly orders; assets, contracts, maintenance plans and deadlines; work orders in every state with visits and parts used; forms and submissions; leads, opportunities and activities; quotes, sales orders and deliveries; employees, expense claims and pay runs; invoices, credit notes and payments; e-invoicing settings and codes; ledger journals and postings. Dates are relative to the day you run it: last month's jobs are done, next week's are booked.

> [!WARNING]
> **It writes made-up data into the database the machine serves**, and makes nine sign-in accounts (in the sign-in server, the `auth` container). No other company is touched, and it never sends anything to the Tax Authority, Stripe or a customer. It is safest on the test box (Stage 10), or on Oracle before real customers arrive. Part D removes it.

### A. Put the seeder on the machine

- [ ] **Get the seeder into the repository.** It is the folder `apps/api/src/demo/` (the command, `cli.ts`, and one file per section under `sections/`) plus one line in `apps/api/package.json`, `"demo-company"`. Merge it into the branch the machine runs (`main`, or `staging` on the test box). The API image builds everything under `apps/api/src`, so nothing else changes.
- [ ] **Rebuild the API on the machine.** Pull the code and rebuild the API and worker images, the same way as a normal update (Stage 11, part D). If the machine pulls GitHub's images instead: the test box waits for "Publish images" on `staging` to go green; production gets the seeder with the release that includes it, by putting that release's tag in `deploy/.env` (Stage 11, part D). Then `pull` and `up -d`.

```bash
# machine (SSH session)
cd /opt/integr8
git pull
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build api worker

# check the seeder is in the image: it prints its help
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/demo/cli.js --help
```

### B. Run it

```bash
# machine (SSH session), from /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/demo/cli.js \
  --owner-email you@YOUR-EMAIL.com \
  --owner-name "Your Name" \
  --slug demo-nile \
  --confirm-production
```

- [ ] **Choose the owner's address.** `--owner-email` is you, the company's owner. If that address already signs in to another company, it keeps its own password and the demo company is added to the companies you can switch between. `--confirm-production` is required whenever `APP_ENV` is `staging` or `production`, so the command cannot add test data by accident. `--slug` is the company's short name; leave it out for a random `demo-…` one.
- [ ] **Optional settings.** `--password "…"` sets the password of every new sign-in account (otherwise one is generated and printed once); `--name "…"` renames the company; `--only crm,sales` fills only some sections (setup, customers and stock always run, because the others need them). `--help` lists everything.
- [ ] **Save what it prints.** It takes a minute or two, printing a line per section, and ends with a table of nine sign-ins: role, email address and password. The other eight people get addresses made from yours, like `you+demo-nile-omar@YOUR-EMAIL.com`, so any mail for them reaches your own inbox (Gmail and most providers deliver `+` addresses). Put the password in your password manager.
- [ ] **Read the end of the output.** `Done` with nothing after the sign-ins means every section went in. "Item(s) were skipped" lists small things the API refused, one per line; the rest is there. "Section(s) did not finish" names the section and the request that was refused; every other section still ran. Running it again makes a second company, so give it a new `--slug`.

> [!NOTE]
> **"A company with the slug … already exists"**: pick another `--slug`. **"Sign-in cannot be served"**: the env file is missing the sign-in secrets; add them (Stage 3, or Stage 11, part Q, on a machine that is already running). **"Refusing …" or "APP_ENV is production"**: add `--confirm-production`. A fresh database with no super admin yet works too: the company's history then names a "Demo seed" staff account that cannot sign in.

### C. Look around

- [ ] **Sign in as the owner** at `https://app.integr8-media.com`. The dashboard has numbers, and every group in the side menu (Work, CRM, Sales, Finance, Accounting, HR, Inventory, Operations) has records in several states: open the lists, then a few records.
- [ ] **Sign in as the other roles**, in a private window, with the addresses and password it printed: an engineer sees the jobs they are on, the viewer cannot change anything, the HR manager sees HR and payroll. The company has no apps of its own yet; to try the phone app, build them with Stage 8 using the demo company's short name.
- [ ] **Check the dashboard**: Companies lists the demo company on Enterprise, Invoiced, with every module on under **Features** and the seed's staff session in its history.

### D. Remove it when you are done

- [ ] **Close the company** from the dashboard, as for any company: its page → **Closing this company**: **Suspend**, then **Export their data** and wait for it to be ready, then **Close this company** with a reason. It is deleted for good seven days later, with its storage bucket.
- [ ] **The eight demo sign-ins** stop working once the company is closed: nobody can sign in to a company that is gone. Their sign-in accounts are deleted when the company is purged, seven days later; your own address keeps its account if it signs in to other companies.

---

## About this page

Prepared for release v1.2.2 (31 October 2026) from the repository's `main` branch: `deploy/compose.yml`, `deploy/.env.example`, `deploy/vps/`, `.github/workflows/`, `docs/deployment/README.md`, `docs/auth/self-hosted-auth.md`, `docs/database/runbook-backup-and-restore.md`, `docs/ai/RUNBOOK.md`, `docs/documents/RUNBOOK.md` and `docs/e-invoicing/RUNBOOK.md`. Since the previous edition, v1.2.0 added the company website data API and v1.2.1 adds the schedule, skills and certificates, and contracts, maintenance and deadlines (Stage 11, parts M to P); v1.1.2 included the AI assistant, PDF documents and ETA e-invoicing, the v1.1.1 API image/config fixes, and the staff app refresh button from pull request 115. v1.2.2 adds self-hosted sign-in and the fixes from the October 2026 pre-production review (Stage 11, part Q): Supabase's cloud is no longer used, the stage that moved the database there is gone, and the test box runs Ubuntu with Arcane. It also adds the off-machine backup copy and the restore drill (Stage 9, part B, and Stage 11, part R), and rollbacks that start on a newer database (Stage 11, part I). The e-invoicing feature remains test-only until validated. Example model ids and prices come from the providers' pages and third-party price lists in October 2026 and were not checked on every provider's own site: confirm them there. Service dashboards move things around; when a menu is not where this says, search the service's own docs for the setting name.

This Markdown checklist is maintained alongside the interactive HTML version in `setup-checklist.html`. To use the HTML version, download it with `setup-checklist.css` and `setup-checklist.js` into one folder and open the `.html` in a browser; progress ticks are saved in that browser. Keep the Markdown and HTML content in sync; `pnpm guide:check` verifies their stages, parts, tick boxes and wording.
