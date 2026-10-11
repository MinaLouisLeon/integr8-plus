-- CRM/ERP plan, phase E3 (ADR-0008), second part: carrying answers over from
-- an asset's last visit, and importing assets from CSV.
--
-- A form started for an asset fills the questions its version marks to carry
-- over from that asset's last submission of the same form. Which ones is kept
-- on the draft, so every device it is opened on can say which answers came
-- from last time. Set when the draft is created; only with an asset.
--
-- And a fourth CSV import kind, `assets`, beside customers, sites and jobs.

alter table submissions
  add column carried_over jsonb,
  add constraint submissions_carried_over_shape check (
    carried_over is null
    or (asset_id is not null
        and jsonb_typeof(carried_over) = 'object'
        and jsonb_typeof(carried_over -> 'fromSubmissionId') = 'string'
        and jsonb_typeof(carried_over -> 'fields') = 'array'));
comment on column submissions.carried_over is
  '{ fromSubmissionId, fields } when answers were carried over from the asset''s last visit.';

alter table imports
  drop constraint imports_kind_known,
  add constraint imports_kind_known check (kind in ('customers', 'sites', 'work_orders', 'assets'));
