# Branches, and how work reaches a customer

```
   your branch ──▶ dev ──▶ staging ──▶ main
                    │         │          │
                 CI on the  nothing   version
                 PR         (test box) release
```

Three long-lived branches. `dev` is where work lands, `staging` is what is
being tested, `main` is what has shipped. The intent is that nothing skips a step,
but nothing enforces it yet: see "Why rules 1 and 2 are not in force". CI checks a
change once, on its pull request into `dev`; promotions to `staging` and `main` carry
code that already passed there.

| Branch    | Takes          | A pull request into it runs | A merge into it produces           |
| --------- | -------------- | --------------------------- | ---------------------------------- |
| `dev`     | any branch     | `ci.yml`, `branch-policy`   | nothing                            |
| `staging` | `dev` only     | `branch-policy` only        | nothing (the test box builds it)   |
| `main`    | `staging` only | `branch-policy` only        | a versioned release, marked latest |

No workflow builds or publishes Docker images: each server builds its own from
the code.

## The rules, and what actually enforces each one

| #   | Rule                                 | Enforced by                                | In force                 |
| --- | ------------------------------------ | ------------------------------------------ | ------------------------ |
| 1   | The three branches cannot be deleted | `.github/rulesets/*.json` (`deletion`)     | **No — not applied yet** |
| 2   | Nothing is pushed to them directly   | `.github/rulesets/*.json` (`pull_request`) | **No — not applied yet** |
| 3   | Any branch may merge into `dev`      | `branch-policy.yml`                        | Yes                      |
| 4   | Only `dev` may merge into `staging`  | `branch-policy.yml`, as a required check   | Check yes, blocking no   |
| 5   | Only `staging` may merge into `main` | `branch-policy.yml`, as a required check   | Check yes, blocking no   |
| 6   | A pull request into `dev` is checked | `ci.yml`                                   | Yes                      |
| 7   | (retired: no nightly on `staging`)   | —                                          | —                        |
| 8   | Merge into `main` builds a version   | `release-main.yml`                         | Yes                      |

### Why rules 1 and 2 are not in force

The rulesets in `.github/rulesets/` have never been applied: on 31 October 2026
`GET repos/MinaLouisLeon/integr8-plus/rulesets` returned `[]`, and pull request
#135 merged into `main` with **PR source is allowed** failing.

When this was written the repository was private on the Free plan, where GitHub
refuses rulesets (`403 Upgrade to GitHub Pro or make this repository public`).
**The repository is now public**, so rulesets are free. Two decisions for the
owner, in this order:

1. **Should it stay public?** It is a commercial product with an
   authentication layer in it, and every secret-handling mistake in its history
   is readable by anyone. If not, make it private again and either take GitHub
   Pro ($4/month) or accept that rules 1, 2, 4 and 5 stay unenforced.
2. **Apply the rulesets** (below), on a public repository or with Pro. Before
   that, check the flow: the rulesets enforce `dev → staging → main`. Feature
   branches were merged straight into `main` until 1.2.2; since 1.2.3 work goes
   into `dev`, and `staging` was created from `dev` on 1 November 2026, so the
   flow can be followed as written.

Until then, two partial controls are in place, and neither is enforcement:

- **A pre-push hook** (`scripts/git-hooks/pre-push-branch-guard.sh`, wired from
  `.husky/pre-push`) refuses to push to or delete `main`, `staging` and `dev`
  from a machine that has run `pnpm install`. Anyone can pass `--no-verify`, and
  a fresh clone that has not installed dependencies has no hook at all.
- **A detector** (the `Push arrived through a pull request` job in
  `branch-policy.yml`) turns the run red when a commit lands on a governed
  branch with no merged pull request behind it. That is after the fact. A silent
  direct push to `main` is still worse than a loud one.

### Why rules 4 and 5 need a workflow at all

Branch protection restricts _who_ may push and _which checks_ must pass. It has
no concept of which branch a pull request came from — that is simply not
something GitHub can express, on any plan.

So the restriction is a check that fails, in `branch-policy.yml`, which the
rulesets then list as **required**. The two halves are load-bearing together:
the workflow decides, the ruleset makes the decision binding.

The check is named **`PR source is allowed`**, and the rulesets name it as a
string. Renaming that job un-enforces rules 4 and 5 silently, because a required
check that never reports is indistinguishable from one that was never required.

## Turning protection on

```bash
scripts/github/apply-branch-protection.sh --dry-run   # what it would change
scripts/github/apply-branch-protection.sh             # do it
```

The rulesets are created with an **empty bypass list**, which includes you. That
is deliberate: "`main` cannot be deleted without my approval" means deleting it
takes a considered edit to the ruleset first, rather than one confident
afternoon and a mistyped refspec. You can always make that edit — you own the
repository — and the edit is recorded.

Two settings worth understanding before you run it:

- **Required approvals are 0.** GitHub does not let anybody approve their own
  pull request. On a repository with one person, any number above zero blocks
  every merge, permanently, with no way out but to edit the ruleset. Raise it
  when there is a second reviewer.
- **The CI jobs are required checks into `dev` only.** `dev.json` lists `Lint,
typecheck, test, build`, `Conventional commits`, `Migrations, isolation,
authentication and API` and `Secret scan` from `ci.yml` beside `PR source is
allowed`, so a red pull request cannot be merged. `ci.yml` does not run on pull
  requests into `staging` or `main`, so `staging.json` and `main.json` require
  only `PR source is allowed`; listing a CI job there would block every promotion,
  because a required check that never reports never passes. Renaming one of those
  jobs blocks every merge until the ruleset is edited to match.

## Day to day

```bash
git switch dev && git pull
git switch -c feat/whatever
# ... work ...
git push -u origin HEAD
gh pr create --base dev
```

Promoting is the same gesture with different branches:

```bash
gh pr create --base staging --head dev  --title "Promote dev to staging"
gh pr create --base main    --head staging --title "Release"
```

A pull request into `staging` or `main` from anywhere else is refused by the
`PR source is allowed` check, with a message saying to retarget it at `dev`.

## What each build does

### `dev` — checked on the pull request

`ci.yml` runs on every pull request into `dev`: formatting, licences, exact
versions, setup-guide parity, lint, typecheck, unit tests, build, the OpenAPI
drift check, commit messages, the form engine in Hermes, the Postgres and real
Auth suites, and the secret scan. Nothing runs after the merge.

### `staging` — the test box

A merge into `staging` runs nothing on GitHub. The home test box checks out
`staging` and builds it (the same steps as the Oracle machine, on Ubuntu).

### `main` — a version

`release-main.yml` runs the shared verification (`verify.yml`, the same checks
as `ci.yml`) on the merge result, then reads the version from the **root `package.json` and nowhere
else**, and refuses to run if a release already exists for it:

```
::error:: v0.4.1 is already released. Bump the version in package.json before
          merging into main. Nothing was published.
```

Releasing one version number twice is how two different binaries end up both
calling themselves `0.4.1`, and only one of them is the one a customer is
running. Bump the version in the pull request that promotes `staging` to `main`.

> The root `package.json` is currently at `0.0.0`, and the version release fails
> deliberately on that. Set it to `0.1.0` — matching the four apps — in the first
> release pull request.

### What a release contains

| Asset                          | What it is                                    |
| ------------------------------ | --------------------------------------------- |
| Desktop installers             | The thing people install. Built per platform. |
| `openapi-<version>.json`       | The published contract for that build         |
| `integr8-api-<version>.tar.gz` | Build output. **Not** a deployment package.   |
| `integr8-web-<version>.tar.gz` | Build output. **Not** a deployment package.   |

The API and the web app deploy; they do not install. Turning their build output
into something a server runs is P19 and P20, and calling a tarball a deployment
before then would be a promise this repository cannot keep.

The release files are built by `build-release-artifacts.yml`, which only the
version release calls. There are no Docker images in a release: the server
builds them from the code.

## Runner minutes, which are finite

A private repository on the Free plan gets 2,000 minutes a month, and they are
not billed evenly (a public repository's standard runners are free): **Linux ×1, Windows ×2, macOS ×10**. A Tauri build takes
15–25 minutes, so one macOS desktop build costs roughly 150–250 charged minutes.

A version release builds the desktop app for Linux, Windows and macOS. Set
`RELEASE_DESKTOP_PLATFORMS` to a JSON array of runner labels to change that, for
example:

```bash
gh variable set RELEASE_DESKTOP_PLATFORMS --body '["ubuntu-latest","windows-latest"]'
gh variable set DESKTOP_BUILDS --body 'disabled'   # skip desktop builds entirely
```

## Secrets and variables

| Name                                                                        | Kind     | Without it                                                                                                          |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`                                                 | secret   | Installers build, but no signed update bundles or `latest.json`: installed apps are never offered them              |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                        | secret   | As above                                                                                                            |
| `DESKTOP_UPDATES_URL`                                                       | variable | Release builds ask `https://app.integr8-media.com/desktop-updates` for updates (the web app's feed)                 |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`                       | secret   | Windows installers are not code-signed (SmartScreen warns). A code-signing certificate as base64 .pfx               |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`                 | secret   | With the three `AZURE_SIGNING_*` variables, signs Windows installers with Azure Artifact Signing instead            |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`  | variable | As above: the account's endpoint URL, account name and certificate profile                                          |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | secret   | macOS apps are not signed (Gatekeeper blocks the first open). A Developer ID Application certificate as base64 .p12 |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`                               | secret   | Notarisation uses the `ASC_*` key below when it exists; otherwise these, or a signed but un-notarised app           |
| `EXPO_TOKEN`                                                                | secret   | Mobile builds cannot authenticate                                                                                   |
| `EAS_BUILDS`                                                                | variable | Company phone builds are skipped. Set to `enabled` to run them                                                      |
| `EAS_PLATFORMS`                                                             | variable | Android only. Set to `all` once Apple credentials exist on Expo                                                     |
| `DESKTOP_BUILDS`                                                            | variable | Set to `disabled` to skip desktop builds                                                                            |
| `PUBLIC_API_URL`                                                            | variable | The release desktop build refuses to run: an installer must know its API                                            |
| `DESKTOP_PUBLIC_SENTRY_DSN`                                                 | variable | Desktop installers report no errors to Sentry                                                                       |
| `BUILD_TOKEN`                                                               | secret   | "Build company apps" for `all` cannot list the companies; the API's `BUILD_TOKEN` must be the same                  |
| `COMPANY_APPS`                                                              | variable | Set to `disabled` to stop the version release building every company's apps                                         |
| `STORE_SUBMIT`                                                              | variable | Company phone builds are not sent to the stores. Set to `enabled` once the store accounts exist                     |
| `GOOGLE_SERVICE_ACCOUNT_KEY`                                                | secret   | With `STORE_SUBMIT`, Android is not submitted. The Play Console service account's JSON key                          |
| `ASC_API_KEY`, `ASC_KEY_ID`, `ASC_ISSUER_ID`                                | secret   | With `STORE_SUBMIT`, iOS is not submitted. An App Store Connect API key (.p8 contents, key id, issuer id)           |
| `ASC_APP_IDS`                                                               | variable | iOS submission needs each company's App Store Connect app id: `{"acme":"1234567890"}`                               |

The desktop installer inlines its API address at build time, so the release
is built against `PUBLIC_API_URL`; a missing value fails the desktop job rather
than producing an installer that talks to `localhost`. The phone app's addresses
live in `apps/mobile/eas.json`, one per build profile, for the same reason.

The Tauri signing key is the private half of the updater keypair — the one in
`apps/desktop/src-tauri/updater.key`, which is git-ignored. Whoever holds it can
sign an update that every installed copy will accept and run, so it belongs in
the repository secrets and a password manager and nowhere else. Its public half
is `plugins.updater.pubkey` in `tauri.conf.json`; the build warns when the two
do not match, and the apps then refuse every update. A version release with the
key attaches signed update bundles and a `latest.json`, which the web app
serves at `/desktop-updates/<staff or company slug>/…` (`GITHUB_RELEASES_REPOSITORY`
in the deployment). Operating-system code signing (the Windows and Apple
secrets) is separate and optional: it changes what Windows and macOS say when
an installer is first opened, not whether updates work. Each is used only when
all of its secrets exist.

`EAS_BUILDS` stays off until `eas init` replaces the placeholder `projectId` in
`apps/mobile/app.config.ts`. A job cannot branch on whether a secret exists,
which is why these are variables rather than inferred from the secrets.

### Company apps

The desktop installer a release attaches is the **staff** flavour: the one
Integr8's own people install, with only the staff sign-in. Each customer gets
apps of their own from `build-company-apps.yml`: desktop installers and phone
apps stamped with the company's name, icon and colours, signing in only that
company's people, published as the release `company-<slug>-v<version>`. The
version release runs it for every company with "Build apps" switched on (the
toggle on the company's page in the platform dashboard); it also runs by hand
from the Actions tab for one company. See `docs/deployment/company-apps.md`.

## The first promotion

The five foundation phases are on `foundation`, which was branched before this
model existed. It goes up the same path as everything else:

```bash
gh pr create --base dev --head foundation --title "feat: foundation phases P01–P05"
```

That is allowed — rule 3 lets any branch into `dev` — and it is a fair test of
the whole pipeline, since it is the change that gives `dev`, `staging` and
`main` an application to build in the first place. Until it lands, the version
release notices there is no `package.json` and stops with a note rather than a
red run.
