# Branches, and how work reaches a customer

```
   your branch ──▶ dev ──▶ staging ──▶ main
                    │         │          │
                 test build  nightly   version
                 only        release   release
```

Three long-lived branches. `dev` is where work lands, `staging` is what is
being tested, `main` is what has shipped. Nothing skips a step, so anything on
`main` has already been built twice and released once as a nightly.

| Branch    | Takes          | A merge into it produces           |
| --------- | -------------- | ---------------------------------- |
| `dev`     | any branch     | a test build, and nothing else     |
| `staging` | `dev` only     | a nightly pre-release              |
| `main`    | `staging` only | a versioned release, marked latest |

## The rules, and what actually enforces each one

| #   | Rule                                  | Enforced by                                | In force                   |
| --- | ------------------------------------- | ------------------------------------------ | -------------------------- |
| 1   | The three branches cannot be deleted  | `.github/rulesets/*.json` (`deletion`)     | **No — needs a paid plan** |
| 2   | Nothing is pushed to them directly    | `.github/rulesets/*.json` (`pull_request`) | **No — needs a paid plan** |
| 3   | Any branch may merge into `dev`       | `branch-policy.yml`                        | Yes                        |
| 4   | Only `dev` may merge into `staging`   | `branch-policy.yml`, as a required check   | Check yes, blocking no     |
| 5   | Only `staging` may merge into `main`  | `branch-policy.yml`, as a required check   | Check yes, blocking no     |
| 6   | Merge into `dev` builds for test      | `release-dev.yml`                          | Yes                        |
| 7   | Merge into `staging` builds a nightly | `release-staging.yml`                      | Yes                        |
| 8   | Merge into `main` builds a version    | `release-main.yml`                         | Yes                        |

### Why rules 1 and 2 are not in force

GitHub does not offer branch protection or rulesets for **private** repositories
on the **Free** plan. The API does not return an empty list; it refuses:

```
GET repos/MinaLouisLeon/integr8-plus/rulesets
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

There is no configuration, token scope or workflow that works around this. The
server will accept a direct push to `main` because nothing has told it not to.

Two ways to close it:

- **GitHub Pro**, $4/month for the account. Then run
  `scripts/github/apply-branch-protection.sh` and rules 1, 2, 4 and 5 all
  become the server's job rather than a convention. This is the intended path.
- **Make the repository public.** This is a commercial product with an
  authentication layer in it. Almost certainly the wrong trade.

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
- **`ci.yml` is not a required check yet.** A required check that never reports
  blocks a pull request forever, and `ci.yml` does not exist on `main` until the
  `foundation` work lands. Add `Lint, typecheck, test, build` to
  `required_status_checks` in all three ruleset files once it does.

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
not billed evenly: **Linux ×1, Windows ×2, macOS ×10**. A Tauri build takes
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

| Name                                 | Kind     | Without it                                                                                          |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | secret   | Installers build, but carry no update signature                                                     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret   | As above                                                                                            |
| `EXPO_TOKEN`                         | secret   | Mobile builds cannot authenticate                                                                   |
| `EAS_BUILDS`                         | variable | Mobile builds are skipped. Set to `enabled` to run them                                             |
| `DESKTOP_BUILDS`                     | variable | Set to `disabled` to skip desktop builds                                                            |
| `PUBLIC_API_URL`                     | variable | The release desktop build refuses to run: an installer must know its API. Shared with the web image |
| `STAGING_PUBLIC_API_URL`             | variable | As above, for the nightly's installer and the staging web image                                     |
| `DESKTOP_PUBLIC_SENTRY_DSN`          | variable | Desktop installers report no errors to Sentry                                                       |

The desktop installer inlines its API address at build time, so the nightly
is built against `STAGING_PUBLIC_API_URL` and the release against
`PUBLIC_API_URL`; a missing value fails the desktop job rather than producing
an installer that talks to `localhost`. The phone app's addresses live in
`apps/mobile/eas.json`, one per build profile, for the same reason.

The Tauri signing key is the private half of the updater keypair — the one in
`apps/desktop/src-tauri/updater.key`, which is git-ignored. Whoever holds it can
sign an update that every installed copy will accept and run, so it belongs in
the repository secrets and a password manager and nowhere else.

`EAS_BUILDS` stays off until `eas init` replaces the placeholder `projectId` in
`apps/mobile/app.json`. A job cannot branch on whether a secret exists, which is
why these are variables rather than inferred from the secrets.

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
