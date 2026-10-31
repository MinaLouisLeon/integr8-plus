# Branches, and how work reaches a customer

```
   your branch ──▶ dev ──▶ staging ──▶ main
                    │         │          │
                 test build  nightly   version
                 only        release   release
```

Three long-lived branches. `dev` is where work lands, `staging` is what is
being tested, `main` is what has shipped. The intent is that nothing skips a step,
but nothing enforces it yet: see "Why rules 1 and 2 are not in force". So anything on
`main` has already been built twice and released once as a nightly.

| Branch    | Takes          | A merge into it produces           |
| --------- | -------------- | ---------------------------------- |
| `dev`     | any branch     | a test build, and nothing else     |
| `staging` | `dev` only     | a nightly pre-release              |
| `main`    | `staging` only | a versioned release, marked latest |

## The rules, and what actually enforces each one

| #   | Rule                                  | Enforced by                                | In force                 |
| --- | ------------------------------------- | ------------------------------------------ | ------------------------ |
| 1   | The three branches cannot be deleted  | `.github/rulesets/*.json` (`deletion`)     | **No — not applied yet** |
| 2   | Nothing is pushed to them directly    | `.github/rulesets/*.json` (`pull_request`) | **No — not applied yet** |
| 3   | Any branch may merge into `dev`       | `branch-policy.yml`                        | Yes                      |
| 4   | Only `dev` may merge into `staging`   | `branch-policy.yml`, as a required check   | Check yes, blocking no   |
| 5   | Only `staging` may merge into `main`  | `branch-policy.yml`, as a required check   | Check yes, blocking no   |
| 6   | Merge into `dev` builds for test      | `release-dev.yml`                          | Yes                      |
| 7   | Merge into `staging` builds a nightly | `release-staging.yml`                      | Yes                      |
| 8   | Merge into `main` builds a version    | `release-main.yml`                         | Yes                      |

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
   that, decide the flow: the rulesets enforce `dev → staging → main`, there is
   no `staging` branch on the server yet, and feature branches have been merged
   straight into `main`. Either create `staging` from `main` and follow the
   flow, or change `main.json`'s source rule before applying it.

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
- **The CI jobs are required checks.** All three ruleset files list `Lint,
typecheck, test, build`, `Conventional commits`, `Migrations, isolation,
authentication and API` and `Secret scan` from `ci.yml` beside `PR source is
allowed`, so a red pull request cannot be merged. Renaming one of those jobs
  blocks every merge until the ruleset is edited to match.

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

### `dev` — test only

`release-dev.yml` runs the shared verification (`verify.yml`: format, lint,
typecheck, test, build, and the OpenAPI drift check) against the **merge
result**, which is not the commit the pull request tested. It publishes nothing.
There is deliberately no artifact anybody could mistake for a release.

### `staging` — a nightly

`release-staging.yml` verifies, then calls `build-release-artifacts.yml` and
publishes a GitHub **pre-release**:

```
v0.1.0-nightly.20260910.g1f2a9f1
```

The `g` before the hash is the `git describe` convention, and it is not
decoration: a commit hash of digits only would otherwise be read as a numeric
semver identifier, and one with a leading zero would not be valid semver at all.

Pre-releases never become "latest", so nothing that reads the latest release
picks up a nightly by accident.

### `main` — a version

`release-main.yml` reads the version from the **root `package.json` and nowhere
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

Both channels build through the **same** workflow with different inputs. If the
nightly and the release were built by two different files, a green nightly would
say nothing useful about the release that follows it.

## Runner minutes, which are finite

A private repository on the Free plan gets 2,000 minutes a month, and they are
not billed evenly (a public repository's standard runners are free): **Linux ×1, Windows ×2, macOS ×10**. A Tauri build takes
15–25 minutes, so one macOS desktop build costs roughly 150–250 charged minutes.

Hence the default split:

| Channel | Desktop platforms     | Variable to override        |
| ------- | --------------------- | --------------------------- |
| nightly | Linux, Windows        | `NIGHTLY_DESKTOP_PLATFORMS` |
| release | Linux, Windows, macOS | `RELEASE_DESKTOP_PLATFORMS` |

A nightly runs on every promotion from `dev`; a version release does not. Set
either variable to a JSON array of runner labels, for example:

```bash
gh variable set NIGHTLY_DESKTOP_PLATFORMS --body '["ubuntu-latest"]'
gh variable set DESKTOP_BUILDS --body 'disabled'   # skip desktop builds entirely
```

## Secrets and variables

| Name                                         | Kind     | Without it                                                                                                |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`                  | secret   | Installers build, but carry no update signature                                                           |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`         | secret   | As above                                                                                                  |
| `EXPO_TOKEN`                                 | secret   | Mobile builds cannot authenticate                                                                         |
| `EAS_BUILDS`                                 | variable | Mobile builds are skipped. Set to `enabled` to run them                                                   |
| `EAS_PLATFORMS`                              | variable | Android only. Set to `all` once Apple credentials exist on Expo                                           |
| `DESKTOP_BUILDS`                             | variable | Set to `disabled` to skip desktop builds                                                                  |
| `PUBLIC_API_URL`                             | variable | The release desktop build refuses to run: an installer must know its API. Shared with the web image       |
| `STAGING_PUBLIC_API_URL`                     | variable | As above, for the nightly's installer and the staging web image                                           |
| `DESKTOP_PUBLIC_SENTRY_DSN`                  | variable | Desktop installers report no errors to Sentry                                                             |
| `BUILD_TOKEN`                                | secret   | "Build company apps" for `all` cannot list the companies; the API's `BUILD_TOKEN` must be the same        |
| `COMPANY_APPS`                               | variable | Set to `disabled` to stop the version release building every company's apps                               |
| `STORE_SUBMIT`                               | variable | Company phone builds are not sent to the stores. Set to `enabled` once the store accounts exist           |
| `GOOGLE_SERVICE_ACCOUNT_KEY`                 | secret   | With `STORE_SUBMIT`, Android is not submitted. The Play Console service account's JSON key                |
| `ASC_API_KEY`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | secret   | With `STORE_SUBMIT`, iOS is not submitted. An App Store Connect API key (.p8 contents, key id, issuer id) |
| `ASC_APP_IDS`                                | variable | iOS submission needs each company's App Store Connect app id: `{"acme":"1234567890"}`                     |

The desktop installer inlines its API address at build time, so the nightly
is built against `STAGING_PUBLIC_API_URL` and the release against
`PUBLIC_API_URL`; a missing value fails the desktop job rather than producing
an installer that talks to `localhost`. The phone app's addresses live in
`apps/mobile/eas.json`, one per build profile, for the same reason. The
`production` profile builds a Play Store bundle; `production-internal` is the
same app as a file a phone installs directly, for handing to engineers before
the store listing exists. Point `RELEASE_EAS_PROFILE` at it to get that from a
release.

The Tauri signing key is the private half of the updater keypair — the one in
`apps/desktop/src-tauri/updater.key`, which is git-ignored. Whoever holds it can
sign an update that every installed copy will accept and run, so it belongs in
the repository secrets and a password manager and nowhere else.

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
`main` an application to build in the first place. Until it lands, all three
release workflows notice there is no `package.json` and stop with a note rather
than a red run.
