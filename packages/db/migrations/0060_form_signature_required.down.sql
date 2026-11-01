drop trigger work_orders_enforce_state_signoff on work_orders;
drop function enforce_work_order_form_signoff();

comment on column forms.signature_required is
  'Whether a signature is mandatory before a job using this form can close. Enforced from P10.';
