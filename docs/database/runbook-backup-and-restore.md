# Runbook — backup and restore

A backup nobody has restored is a hypothesis. This runbook has two halves:
configuring backups, which takes ten minutes, and rehearsing a restore, which
takes an hour and is the half that matters.

---

## Part 1 — configure backups

### Supabase's own backups

**Project Settings → Database → Backups.**

| Plan       | What you get                                         |
| ---------- | ---------------------------------------------------- |
| Free       | No automated backups. Not acceptable for production. |
| Pro        | Daily backups, 7-day retention.                      |
| Pro + PITR | Point-in-time recovery, 2-minute granularity.        |

Production runs on Pro with PITR. Daily backups bound data loss at 24 hours;
PITR bounds it at minutes, and the difference is the difference between "we lost
yesterday afternoon's job sheets" and "we lost the last two minutes".

Confirm on the Backups page that the most recent backup is less than 24 hours
old. Do this monthly, or wire it into whatever already pages you.

### An independent copy

Supabase's backups live inside the account they protect. If that account is
suspended or a project is deleted, they go with it. Take one weekly logical dump
somewhere else.

```bash
# Requires postgresql-client 15 or newer.
# Runs from a machine with the direct (5432) connection string.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="integr8-$(date +%Y-%m-%d).dump" \
  "$DATABASE_URL_ADMIN"
```

- `--format=custom` gives selective restore and parallelism.
- `--no-owner` / `--no-privileges` because roles differ between the source and
  wherever you restore. Roles are recreated by `db bootstrap`, which is why they
  are not in migrations.

Store it encrypted, somewhere not reachable with the credentials that reach the
database. Retain thirteen months.

> **This dump contains every customer's data.** It is the most sensitive
> artefact the company holds. Encrypt at rest, restrict access to named people,
> and log every retrieval.

### Verify a dump is readable

A dump that will not restore is worse than none, because you will not look for
another. Weekly, in CI or by hand:

```bash
pg_restore --list "integr8-2026-09-10.dump" > /dev/null && echo "readable"
```

---

## Part 2 — rehearse a restore

**Do this before the first customer, and every six months after.** Record the
result in the table at the bottom of this file. An untimed restore procedure
means you cannot answer "how long until we are back?", which is the only
question anyone will ask.

### Rehearsal, into a scratch project

1. **Create a scratch Supabase project.** Same region and plan as production, so
   the timing is honest.

2. **Note the start time.**

   ```bash
   date -u +%H:%M:%S
   ```

3. **Restore the dump.**

   ```bash
   pg_restore \
     --dbname="$SCRATCH_DATABASE_URL_ADMIN" \
     --no-owner \
     --no-privileges \
     --jobs=4 \
     integr8-2026-09-10.dump
   ```

   `--jobs=4` restores tables in parallel. Expect complaints about extensions
   and roles that already exist; those are harmless. Anything mentioning a
   **table** is not.

4. **Recreate the runtime role.** The dump has no roles in it.

   ```bash
   export INTEGR8_APP_PASSWORD="$(openssl rand -base64 32)"
   DATABASE_URL_ADMIN="$SCRATCH_DATABASE_URL_ADMIN" \
     pnpm --filter @integr8/db db bootstrap
   ```

5. **Check the schema is at the expected version.**

   ```bash
   DATABASE_URL_ADMIN="$SCRATCH_DATABASE_URL_ADMIN" \
     pnpm --filter @integr8/db db status
   ```

   Every line `applied`. A `pending` line means the dump predates a migration —
   run `db up` and note it, because it tells you the backup and the deployed
   code were out of step.

6. **Check the data.** Row counts against what production reported at dump time:

   ```sql
   select
     (select count(*) from tenants)      as tenants,
     (select count(*) from tenant_users) as members,
     (select count(*) from audit_log)    as audit_entries;
   ```

7. **Check isolation survived the restore.** Grants and policies are the parts
   most likely to be lost by `--no-privileges`, and losing them silently is the
   worst possible outcome of a restore.

   ```bash
   # In a scratch .env, pointed at the restored project
   APP_ENV=test
   INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable

   pnpm --filter @integr8/db test:integration
   ```

   > This truncates tables. Only ever run it against the scratch project, never
   > against the restored copy if you intend to promote that copy to production.
   > For a real restore, use the read-only checks in step 8 instead.

8. **For a real restore, verify without destroying.** Connect as `integr8_app`
   and confirm the backstop is intact:

   ```sql
   -- Should return only this tenant's rows.
   begin;
   select set_config('app.tenant_id', '<a real tenant id>', true);
   select count(*), count(distinct tenant_id) from tenant_users;
   commit;

   -- Should fail with: permission denied for table platform_users
   select 1 from platform_users;
   ```

   One distinct `tenant_id`, and a permission error on the second. Anything else
   means the restore lost its grants or policies and must not serve traffic.

9. **Note the finish time**, and record the result below.

10. **Delete the scratch project.** It holds a full copy of customer data.

### A real restore

Same steps, plus:

- **Stop the API first.** Writes landing during a restore are lost, and a
  half-restored database serving traffic corrupts more than it recovers.
- **Prefer PITR to a dump.** Supabase's dashboard restore to a timestamp loses
  minutes; a nightly dump loses up to a day.
- **Restore into a new project, then repoint**, rather than restoring over the
  live one. If the restore is bad you still have the original.
- **Write the incident up the same day**, while you remember what was confusing.

---

## Recovery objectives

| Measure                                   | Target    | Mechanism                    |
| ----------------------------------------- | --------- | ---------------------------- |
| RPO — how much data we can afford to lose | 5 minutes | Supabase PITR                |
| RPO without PITR                          | 24 hours  | Daily automated backup       |
| RPO if the Supabase account is lost       | 7 days    | Weekly independent `pg_dump` |
| RTO — how long until we are serving again | 2 hours   | This runbook, rehearsed      |

The RTO is a claim until a rehearsal supports it. Fill in the table below.

## Rehearsal log

| Date                                          | Performed by | Source | Restore time | Data verified | Notes |
| --------------------------------------------- | ------------ | ------ | ------------ | ------------- | ----- |
| _(not yet rehearsed — see P02 exit criteria)_ |              |        |              |               |       |
