# P18 — Marketing site and self-serve onboarding

**Version:** v1.0 Launch
**Status:** `NOT STARTED`
**Depends on:** P17

## Goal

A stranger finds the product, understands it, pays, and is working inside it — with no
involvement from you.

## Scope

The Next.js public surface and the signup-to-productive path.

## Tasks

- [ ] Landing page stating what the product does for whom, in their words
- [ ] Features and pricing pages, with the plan limits stated honestly
- [ ] Signup flow: account → company → Stripe Checkout → provisioned tenant → owner invited
- [ ] Guided first-run: create a job type, clone a starter form, invite an engineer, download the apps
- [ ] Starter form template library visible during onboarding
- [ ] Demo company data, clearly labelled, removable in one click
- [ ] Company settings: branding and logo, working hours, timezone, currency, locale, job types
- [ ] User management: invite, deactivate, change role, resend invite
- [ ] Billing portal surfacing plan, invoices, seats and current usage
- [ ] Help centre with the first fifteen articles, written from real support questions
- [ ] Analytics on the signup funnel, so you can see where people drop out

## Exit criteria

- [ ] A test user signs up, pays and completes a job in the mobile app, with no manual step from you
- [ ] Time from landing page to first submitted form is under thirty minutes, measured
- [ ] Every plan limit shown on the pricing page matches what the entitlement service enforces
- [ ] The funnel is instrumented and drop-off is visible per step

## Notes

- The guided first run matters more than the landing page. Companies churn in week one
  because nothing happened, not because the marketing was weak.
- Starter templates are your fastest onboarding lever. Ship at least six real ones for
  your target trade.
