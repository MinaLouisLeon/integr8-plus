#!/usr/bin/env sh
#
# Refuse to push directly to main, staging or dev.
#
# This is the only thing that actually *prevents* a direct push while the
# repository is private on the Free plan, where GitHub offers no branch
# protection. It runs on this machine, so it protects this machine — a
# colleague who has not run `pnpm install` has no hook at all, and anyone can
# pass --no-verify. Real enforcement is scripts/github/apply-branch-protection.sh,
# once the plan allows it.
#
# Wired up from .husky/pre-push. Git passes the refs being pushed on stdin as:
#
#     <local ref> <local sha> <remote ref> <remote sha>
#
# so the branch that matters is the *remote* one. Pushing a local branch called
# anything at all to refs/heads/main is still a push to main.

set -eu

protected='refs/heads/main refs/heads/staging refs/heads/dev'

if [ "${INTEGR8_ALLOW_PROTECTED_PUSH:-}" = '1' ]; then
  echo "pre-push: INTEGR8_ALLOW_PROTECTED_PUSH is set; not checking the target branch." >&2
  exit 0
fi

while read -r _local_ref local_sha remote_ref _remote_sha; do
  # A deletion pushes the all-zero sha. Rule 1 says these branches do not get
  # deleted, and a typo in a refspec is the usual way it happens.
  # Padded on both sides so that a branch named "de" does not match "dev".
  case " $protected " in
    *" $remote_ref "*)
      case "$local_sha" in
        0000000000000000000000000000000000000000)
          echo >&2
          echo "  Refusing to delete ${remote_ref#refs/heads/}." >&2
          echo >&2
          echo "  main, staging and dev are not deleted. If that is genuinely what you want," >&2
          echo "  do it on github.com, where it is recorded." >&2
          echo >&2
          ;;
        *)
          echo >&2
          echo "  Refusing to push straight to ${remote_ref#refs/heads/}." >&2
          echo >&2
          echo "  Work reaches main the same way every time:" >&2
          echo >&2
          echo "      your branch  ->  dev  ->  staging  ->  main" >&2
          echo >&2
          echo "  Push your branch and open a pull request into dev:" >&2
          echo >&2
          echo "      git push -u origin HEAD" >&2
          echo "      gh pr create --base dev" >&2
          echo >&2
          echo "  If you are certain, and can say why: INTEGR8_ALLOW_PROTECTED_PUSH=1 git push" >&2
          echo "  (Prefer that to --no-verify, which also skips the typecheck and the tests.)" >&2
          echo >&2
          ;;
      esac
      exit 1
      ;;
  esac
done

exit 0
