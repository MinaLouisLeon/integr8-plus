-- 0060 - a form's "signature required before close" setting is enforced (P07, P14).
--
-- The form builder has stored `forms.signature_required` since 0007 and said
-- it would be enforced, but completing a job only ever looked at the job's own
-- `signature_required`, copied from its job type (0013). A company that ticked
-- the box on its inspection form could close an inspection with nobody's
-- signature on it.
--
-- From here a job cannot be completed without a sign-off when its job type
-- asks for one OR any submission on the job (draft, submitted or reopened) is
-- of a form whose setting is ticked. A sign-off is what it always was: a
-- signature, or the reason nobody could sign.
--
-- The setting is read from the form, not from the version a submission was
-- filled on. It is a form setting, kept outside the published definition, and
-- published versions are immutable: copying it into them would freeze the
-- choice made when each version was published, so a company that ticks the box
-- today would still close jobs filled on yesterday's version unsigned. Reading
-- the form means the box means what the builder says it means — before a job
-- using this form can close — from the moment it is ticked, and unticking it
-- relaxes open jobs at once. Jobs already completed are not looked at again.
--
-- A trigger of its own beside enforce_work_order_state (0013) rather than a
-- copy of that function: the state machine stays where it is, and this check
-- comes and goes on its own. It runs after it (triggers fire in name order),
-- so a transition the state machine refuses is refused for that reason first.

create function enforce_work_order_form_signoff() returns trigger
language plpgsql
as $$
declare
  forms_asking text;
begin
  if new.state = 'complete' and old.state is distinct from 'complete' and new.signed_off_at is null then
    select string_agg(distinct f.title, ', ') into forms_asking
      from submissions s
      join forms f on f.tenant_id = s.tenant_id and f.id = s.form_id
     where s.tenant_id = new.tenant_id
       and s.work_order_id = new.id
       and f.signature_required;
    if forms_asking is not null then
      raise exception 'work order % cannot be completed: the customer has not signed off (asked for by %)',
        old.id, forms_asking
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function enforce_work_order_form_signoff() is
  'Refuses completing a job without a sign-off when any submission on it is of a form whose signature_required is set (0060). The job type''s own requirement is checked by enforce_work_order_state.';

-- Named to sort after work_orders_enforce_state.
create trigger work_orders_enforce_state_signoff
  before update of state on work_orders
  for each row execute function enforce_work_order_form_signoff();

comment on column forms.signature_required is
  'Whether a signature is mandatory before a job with a submission of this form can close. Read from the form at completion (0060), not from the version filled.';
