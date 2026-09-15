-- 0014 — repeating groups (P13b).
--
-- A repeatable section's answer is a list of entries, each with a stable id and
-- the answers to the section's fields:
--
--   "appliances": [{"id": "0192f3a4-…", "values": {"make": "Worcester"}}]
--
-- A published version's reportable_fields marks each field of a repeatable
-- section with that section ({"field", "type", "multiple", "section"}), as
-- @integr8/form-engine computes it. Each entry's answers are reported in rows of
-- their own, so "every submission with a Worcester boiler" finds a submission
-- whichever entry the Worcester was in, and a report can still tell entries
-- apart:
--
--   submission_values.entry_id       the entry's id, or null for an answer outside entries
--   submission_values.entry_index    its position in the list when submitted, from 0; 0 outside entries
--
-- A field id is unique within a form and a field is either in a repeatable
-- section or not, so (field_id, entry_index, ordinal) still names one value.

alter table submission_values
  add column entry_id text,
  add column entry_index integer not null default 0;

alter table submission_values
  add constraint submission_values_entry_shape check (
    entry_index >= 0
    and (entry_id is not null or entry_index = 0)
    and (entry_id is null or entry_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')
  );

alter table submission_values drop constraint submission_values_pk;
alter table submission_values
  add constraint submission_values_pk
    primary key (tenant_id, submission_id, field_id, entry_index, ordinal);

comment on column submission_values.entry_id is
  'For a field of a repeatable section: the id of the entry the answer is in. Null for every other answer.';
comment on column submission_values.entry_index is
  'For a field of a repeatable section: the entry''s position when submitted, from 0. 0 for every other answer.';

-- Reported entry by entry. Otherwise as in 0012.
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
    (tenant_id, submission_id, form_id, form_version_id, field_id, entry_id, entry_index, ordinal,
     value_type, value_text, value_number, value_date, value_time, value_timestamp, value_boolean,
     submitted_at)
  select new.tenant_id, new.id, new.form_id, new.form_version_id, item.field, item.entry_id,
         item.entry_index, item.ordinal, item.type,
         case when item.type = 'text' then left(item.value, 512) end,
         case when item.type = 'number' then item.value::numeric end,
         case when item.type = 'date' then item.value::date end,
         case when item.type = 'time' then item.value::time end,
         case when item.type = 'datetime' then item.value::timestamptz end,
         case when item.type = 'boolean' then item.value::boolean end,
         new.submitted_at
    from (
      -- Where each reportable answer lives: the answers themselves, or — for a
      -- field of a repeatable section — the values of each of its entries.
      with answered as (
        select spec, null::text as entry_id, 0 as entry_index, new.answers as answers
          from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
         where spec ->> 'section' is null
        union all
        select spec, entry.value ->> 'id', (entry.ordinality - 1)::integer, entry.value -> 'values'
          from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(new.answers -> (spec ->> 'section')) = 'array'
                 then new.answers -> (spec ->> 'section')
                 else '[]'::jsonb end
          ) with ordinality as entry (value, ordinality)
         where spec ->> 'section' is not null
           and jsonb_typeof(entry.value -> 'values') = 'object'
      )
      select spec ->> 'field' as field,
             spec ->> 'type' as type,
             entry_id,
             entry_index,
             0 as ordinal,
             answers ->> (spec ->> 'field') as value
        from answered
       where not coalesce((spec ->> 'multiple')::boolean, false)
      union all
      select spec ->> 'field',
             spec ->> 'type',
             entry_id,
             entry_index,
             (option.ordinality - 1)::integer,
             option.value
        from answered
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(answers -> (spec ->> 'field')) = 'array'
               then answers -> (spec ->> 'field')
               else '[]'::jsonb end
        ) with ordinality as option (value, ordinality)
       where coalesce((spec ->> 'multiple')::boolean, false)
    ) as item
   where item.value is not null and item.value <> '';

  return null;
end;
$$;

-- Submissions already submitted against versions with repeatable sections: none
-- exist before this migration, because no earlier engine could publish one.
