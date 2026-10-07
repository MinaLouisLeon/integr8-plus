-- Billing mode per company.
--
-- Two ways a company pays. `self_serve`: it subscribes in the app and the
-- provider (Stripe) takes the money, with trials, dunning and read-only as
-- P17 built them. `invoiced`: Integr8 invoices the company directly, sets its
-- plan from the platform dashboard, and the app shows no checkout, no card
-- portal and no provider invoices. Every existing company keeps paying the way
-- it did, which is what the default says.
--
-- On `tenants` rather than `subscriptions`: the mode is a decision about the
-- company that holds whether or not a subscription row exists yet, and the
-- door-check already caches the company row, so the billing screens and the
-- checkout refusal read it for free.

alter table tenants
  add column billing_mode text not null default 'self_serve';

alter table tenants
  add constraint tenants_billing_mode_known
    check (billing_mode in ('self_serve', 'invoiced'));

comment on column tenants.billing_mode is
  'self_serve: subscribes in the app via the billing provider. invoiced: Integr8 invoices directly; the plan is set from the platform dashboard.';
