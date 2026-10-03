-- 0012 — where a form was submitted from (P13).
--
-- A phone records its location when a form is submitted: where the engineer was,
-- how sure the phone was, and when it knew. It is evidence about the visit, kept
-- apart from the answers, so a form needs no GPS question for it and a desktop
-- submission simply has none.
--
--   submissions.submit_location        the latest submit's location, or null
--   submission_events.location         each submit's and amendment's, for history
--
-- The shape, checked here and in full by the API:
--
--   {"status": "captured", "latitude": "53.800712", "longitude": "-1.549100",
--    "accuracyMeters": "7.3", "capturedAt": "2026-09-15T10:04:31.000Z"}
--   {"status": "denied"}        the person refused location access
--   {"status": "unavailable"}   no fix in time: a basement, a plant room
--
-- A location can be written only as part of submitting. Once submitted it is as
-- fixed as the answers.

alter table submissions
  add column submit_location jsonb;

alter table submissions
  add constraint submissions_submit_location_shape check (
    submit_location is null
    or (
      jsonb_typeof(submit_location) = 'object'
      and (
        (submit_location ->> 'status' = 'captured'
          and submit_location ?& array['latitude', 'longitude', 'capturedAt'])
        or submit_location ->> 'status' in ('denied', 'unavailable')
      )
    )
  );

comment on column submissions.submit_location is
  'Where the device was when this was last submitted: captured with accuracy and time, or why not. Null when the device did not record one (web, desktop).';

alter table submission_events
  add column location jsonb;

comment on column submission_events.location is
  'For submitted and amended events: submissions.submit_location as it was written by that submit.';

create function guard_submit_location() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.submit_location is not null and new.status <> 'submitted' then
      raise exception 'submission % has a submit location but was not submitted', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.submit_location is distinct from old.submit_location
     and not (old.status in ('draft', 'reopened') and new.status = 'submitted') then
    raise exception 'the submit location of submission % is written only by submitting it', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

comment on function guard_submit_location() is
  'Refuses a submit location written other than by submitting: set on a draft, or changed after the fact.';

create trigger submissions_location_guard
  before insert or update on submissions
  for each row execute function guard_submit_location();

-- The history records each submit's location. Otherwise as in 0008.
create or replace function record_submission_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  event_kind text;
  next_sequence integer;
  reportable jsonb;
begin
  if tg_op = 'INSERT' then
    event_kind := case when new.status = 'submitted' then 'submitted' end;
  elsif old.status is distinct from new.status then
    event_kind := case
      when old.status = 'draft' then 'submitted'
      when new.status = 'reopened' then 'reopened'
      else 'amended'
    end;
  end if;

  if event_kind is null then
    return null;
  end if;

  select coalesce(max(sequence), 0) + 1 into next_sequence
    from public.submission_events
   where submission_id = new.id;

  insert into public.submission_events
    (tenant_id, submission_id, sequence, kind, answers, actor_id, reason, location)
  values
    (new.tenant_id, new.id, next_sequence, event_kind,
     case when event_kind = 'reopened' then null else new.answers end,
     new.last_actor,
     case when event_kind = 'submitted' then null else new.last_reason end,
     case when event_kind = 'reopened' then null else new.submit_location end);

  if event_kind = 'reopened' then
    -- The last submitted values stay reportable while a correction is drafted.
    return null;
  end if;

  delete from public.submission_values where submission_id = new.id;

  select reportable_fields into reportable
    from public.form_versions
   where tenant_id = new.tenant_id and id = new.form_version_id;

  insert into public.submission_values
    (tenant_id, submission_id, form_id, form_version_id, field_id, ordinal, value_type,
     value_text, value_number, value_date, value_time, value_timestamp, value_boolean, submitted_at)
  select new.tenant_id, new.id, new.form_id, new.form_version_id, entry.field, entry.ordinal, entry.type,
         case when entry.type = 'text' then left(entry.value, 512) end,
         case when entry.type = 'number' then entry.value::numeric end,
         case when entry.type = 'date' then entry.value::date end,
         case when entry.type = 'time' then entry.value::time end,
         case when entry.type = 'datetime' then entry.value::timestamptz end,
         case when entry.type = 'boolean' then entry.value::boolean end,
         new.submitted_at
    from (
      select spec ->> 'field' as field,
             spec ->> 'type' as type,
             0 as ordinal,
             new.answers ->> (spec ->> 'field') as value
        from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
       where not coalesce((spec ->> 'multiple')::boolean, false)
      union all
      select spec ->> 'field',
             spec ->> 'type',
             (option.ordinality - 1)::integer,
             option.value
        from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(new.answers -> (spec ->> 'field')) = 'array'
               then new.answers -> (spec ->> 'field')
               else '[]'::jsonb end
        ) with ordinality as option (value, ordinality)
       where coalesce((spec ->> 'multiple')::boolean, false)
    ) as entry
   where entry.value is not null and entry.value <> '';

  return null;
end;
$$;
