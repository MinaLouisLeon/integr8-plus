<!--
Where this can go:

    your branch  ->  dev        any branch may open this
    dev          ->  staging    publishes a nightly
    staging      ->  main       publishes a version

A pull request into staging or main from anywhere else is refused by the
"PR source is allowed" check. See docs/contributing/branching.md.
-->

## What this changes

<!-- One or two sentences. What is different afterwards, not what you typed. -->

## Why

<!-- The problem, or the phase and exit criterion this closes. -->

## How it was verified

<!--
What you actually ran, and what it said. "Should work" is not verification.
If something is unproven, say so here rather than leaving it to be discovered.
-->

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [ ] Any new user-facing string goes through `@integr8/i18n`
- [ ] Any new layout uses logical properties, and reads correctly right-to-left

## Anything left undone

<!-- Blocked work, follow-ups, and what is blocking them. Delete if none. -->
