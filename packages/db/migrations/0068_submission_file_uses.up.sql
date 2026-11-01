-- 0068 — which submissions name which files (docs/media).
--
-- Two questions used to be answered by reading every submission of the
-- company as text and looking for the file's id in it: "may this file be
-- deleted?" (a file a submission or its history names may not) and, from
-- this release, "who may read this file?" (whoever may read a submission that
-- names it). Both were a scan of the whole company per question.
--
-- This index answers them by key. One row per file a submission names, by
-- where it is named:
--
--   answers  the submission's answers as they stand, drafts included; kept
--            in step on every insert and every change of the answers, so a
--            photo taken off a draft stops counting;
--   history  any answers the submission was ever submitted or amended with
--            (submission_events), which never change, so neither do these.
--
-- Answers name a file as `{ "mediaId": "<uuid>", ... }`, at any depth (a
-- repeating group nests them). A phone names a file before it has uploaded
-- it, so there is no key to `files`: the id is recorded as named.
--
-- Written by trigger, from every path a submission is saved by (the web, the
-- desktop, a phone's sync, a staff correction), with security definer like
-- the submission history itself: the runtime role may only read it.

create table submission_file_uses (
  tenant_id      uuid not null references tenants (id) on delete restrict,
  file_id        uuid not null,
  submission_id  uuid not null,
  source         text not null,

  constraint submission_file_uses_pkey primary key (tenant_id, file_id, submission_id, source),
  constraint submission_file_uses_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id) on delete cascade,
  constraint submission_file_uses_source_known check (source in ('answers', 'history'))
);

comment on table submission_file_uses is
  'Which files each submission names, in its answers now or in its history (0068). Maintained by trigger; read-only to the runtime role.';

create index submission_file_uses_submission on submission_file_uses (tenant_id, submission_id);

-- The file ids an answers document names: every string under a "mediaId" key,
-- at any depth, that is a uuid. Anything else is not a file reference.
create function submission_answer_file_ids(answers jsonb) returns setof uuid
language sql
immutable
set search_path = pg_catalog, public
as $$
  select distinct (found #>> '{}')::uuid
    from jsonb_path_query(coalesce(answers, '{}'::jsonb), 'lax $.**.mediaId', '{}', true) as found
   where jsonb_typeof(found) = 'string'
     and (found #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create function record_submission_file_uses() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'submission_events' then
    if new.answers is not null then
      insert into public.submission_file_uses (tenant_id, file_id, submission_id, source)
      select new.tenant_id, file_id, new.submission_id, 'history'
        from public.submission_answer_file_ids(new.answers) as file_id
      on conflict do nothing;
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' and new.answers is not distinct from old.answers then
    return null;
  end if;
  delete from public.submission_file_uses
   where tenant_id = new.tenant_id and submission_id = new.id and source = 'answers';
  insert into public.submission_file_uses (tenant_id, file_id, submission_id, source)
  select new.tenant_id, file_id, new.id, 'answers'
    from public.submission_answer_file_ids(new.answers) as file_id
  on conflict do nothing;
  return null;
end;
$$;

comment on function record_submission_file_uses() is
  'Keeps submission_file_uses in step with submissions.answers and submission_events (0068). Security definer: the runtime role cannot write the index.';

create trigger submissions_record_file_uses
  after insert or update of answers on submissions
  for each row execute function record_submission_file_uses();

create trigger submission_events_record_file_uses
  after insert on submission_events
  for each row execute function record_submission_file_uses();

-- Every submission and every history entry written before this migration.
insert into submission_file_uses (tenant_id, file_id, submission_id, source)
select s.tenant_id, file_id, s.id, 'answers'
  from submissions s
  cross join lateral submission_answer_file_ids(s.answers) as file_id
on conflict do nothing;

insert into submission_file_uses (tenant_id, file_id, submission_id, source)
select e.tenant_id, file_id, e.submission_id, 'history'
  from submission_events e
  cross join lateral submission_answer_file_ids(e.answers) as file_id
 where e.answers is not null
on conflict do nothing;

grant select on submission_file_uses to integr8_app;

alter table submission_file_uses enable row level security;

create policy submission_file_uses_isolation on submission_file_uses for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
