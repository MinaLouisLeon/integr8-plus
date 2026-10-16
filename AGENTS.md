<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# The setup guide

The setup guide exists in several copies that are one document. Whenever you change one, change all of them in the same piece of work, and say so in the summary:

1. **The published page** (the Claude artifact that the owner opens and shares, one fixed link; update it by publishing the same file path again).
2. **`docs/deployment/setup-checklist.md`**: the same stages, parts and tick boxes in Markdown.
3. **`docs/deployment/setup-checklist.html`**, **`setup-checklist.css`** and **`setup-checklist.js`**: the page as three files the owner downloads and opens locally. They must render the same as the published page.

Run `pnpm guide:check` before you commit: it fails if the Markdown and the HTML differ in stages, parts, tick boxes or their words, or if the page does not load its stylesheet and script. It cannot see the published page, so republish it yourself. Do not pad one copy with steps the others lack; if a step belongs in the guide, it belongs in every copy.
