drop trigger if exists submissions_location_guard on submissions;
drop function if exists guard_submit_location();

-- The history trigger as 0008 wrote it, before it recorded locations.
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
    (tenant_id, submission_id, sequence, kind, answers, actor_id, reason)
  values
    (new.tenant_id, new.id, next_sequence, event_kind,
     case when event_kind = 'reopened' then null else new.answers end,
     new.last_actor,
     case when event_kind = 'submitted' then null else new.last_reason end);

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

alter table submission_events
  drop column if exists location;

alter table submissions
  drop constraint if exists submissions_submit_location_shape,
  drop column if exists submit_location;
