#!/usr/bin/env bash
#
# Apply the branch rulesets in .github/rulesets/ to the repository.
#
#   scripts/github/apply-branch-protection.sh            # apply
#   scripts/github/apply-branch-protection.sh --dry-run  # show what would change
#
# Rulesets are what actually stop a direct push to main and what stops main
# being deleted. The workflow in .github/workflows/branch-policy.yml can only
# notice afterwards; this is the part that refuses.
#
# Every ruleset here has an empty bypass list, which includes you. That is the
# point: "main cannot be deleted without my approval" means deleting it takes a
# deliberate, logged edit to the ruleset first, rather than one confident
# afternoon and a `git push --delete`.
#
# Requires: gh, authenticated, with admin on the repository.

set -euo pipefail

# Git Bash rewrites arguments that look like absolute paths into Windows paths,
# which turns an API route into C:/Program Files/Git/repos/...
export MSYS_NO_PATHCONV=1

dry_run=false
[ "${1:-}" = '--dry-run' ] && dry_run=true

root=$(git rev-parse --show-toplevel)
rulesets_dir="${root}/.github/rulesets"

if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI is not installed. See https://cli.github.com." >&2
  exit 1
fi

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "Repository: ${repo}"
echo

# ---------------------------------------------------------------------------
# Is branch protection available at all?
# ---------------------------------------------------------------------------
#
# It is not, on a private repository on the Free plan. The API says so with a
# 403 rather than an empty list, so this check is worth making before the first
# write rather than reading a confusing failure four rulesets in.

if ! existing=$(gh api "repos/${repo}/rulesets" --jq '[.[] | {id, name}]' 2>/dev/null); then
  message=$(gh api "repos/${repo}/rulesets" 2>&1 || true)

  if printf '%s' "$message" | grep -qi 'upgrade to github pro'; then
    cat >&2 <<'BLOCKED'
Branch protection is not available on this repository.

GitHub does not offer rulesets or branch protection for *private* repositories
on the Free plan. The API refuses with:

    Upgrade to GitHub Pro or make this repository public to enable this feature.

Two ways forward, and they are both yours to choose:

  * GitHub Pro, currently $4/month for the account. Rulesets then apply to
    private repositories and this script works unchanged.
  * Make the repository public. This is a commercial product with an
    authentication layer in it, so that is almost certainly the wrong trade.

Until then, what is actually in force is documented in
docs/contributing/branching.md: a pre-push hook on each machine, and a workflow
that turns a direct push red after the fact. Neither refuses the push.
BLOCKED
    exit 2
  fi

  printf 'Could not read the repository rulesets:\n%s\n' "$message" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Apply each ruleset, creating or updating by name
# ---------------------------------------------------------------------------

for file in "${rulesets_dir}"/*.json; do
  name=$(jq -r .name "$file")
  id=$(printf '%s' "$existing" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)

  if [ -n "$id" ] && [ "$id" != 'null' ]; then
    action='update'
    method='PUT'
    endpoint="repos/${repo}/rulesets/${id}"
  else
    action='create'
    method='POST'
    endpoint="repos/${repo}/rulesets"
  fi

  if [ "$dry_run" = true ]; then
    printf '%-8s %-10s %s\n' "$action" "$name" "$endpoint"
    continue
  fi

  gh api --method "$method" "$endpoint" --input "$file" >/dev/null
  printf '%-8s %s\n' "${action}d" "$name"
done

[ "$dry_run" = true ] && exit 0

echo
echo "In force now:"
gh api "repos/${repo}/rulesets" \
  --jq '.[] | "  \(.name)  [\(.enforcement)]  \(.target)"'

cat <<'AFTER'

Two things worth checking by hand:

  * Required approvals are set to 0. GitHub does not let anyone approve their
    own pull request, so on a repository with one person any higher number
    blocks every merge permanently. Raise it when there is a second reviewer.

  * The required check is named "PR source is allowed" and comes from
    .github/workflows/branch-policy.yml. Renaming that job un-enforces the rule
    silently, because a required check that never reports is an absent one.
AFTER
