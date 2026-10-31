# Runbook — backup and restore

The database is the compose stack's own Postgres (`deploy/compose.yml`), on the
same machine as the API. There is no managed provider behind it, so there are
no backups unless this runbook sets them up.

A backup nobody has restored is a hypothesis. This runbook has two halves:
scheduling the nightly dump, which takes ten minutes, and rehearsing a
restore, which takes an hour and is the half that matters.

---

## What is backed up

`deploy/vps/backup-postgres.sh` dumps the **whole `integr8` database** with
`pg_dump`, as plain SQL compressed with gzip:

- every company's data, in the `public` schema;
- the sign-in accounts of the self-hosted Supabase Auth (P36), in the `auth`
  schema. Passwords are stored there as bcrypt hashes. No separate backup of
  Auth is needed, and none exists.

Roles are not in the dump (they are cluster-wide, not per database).
`deploy/compose.yml`'s `bootstrap` service creates all three — `integr8_app`,
`integr8_auth` and `supabase_auth_admin` — from the env file every time the
stack starts.

| Setting   | Default                        | Meaning                               |
| --------- | ------------------------------ | ------------------------------------- |
| Files     | `/var/backups/integr8`         | `BACKUP_DIR`; the directory is `0700` |
| Name      | `integr8-YYYYMMDD-HHMM.sql.gz` | UTC time of the dump                  |
| Kept      | 14                             | `KEEP`; older files are deleted       |
| Repo path | `/opt/integr8`                 | `INTEGR8_DIR`; where compose.yml is   |

> **A dump contains every customer's data and every password hash.** It is the
> most sensitive file the company holds. Keep the directory readable by root
> only, and never copy a dump to a laptop or a chat.

## Part 1 — schedule it nightly

On the server, as root (the script talks to Docker):

```bash
sudo crontab -e
```

Add:

```cron
0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
```

Run it once by hand so the first file exists and any error shows now:

```bash
sudo /opt/integr8/deploy/vps/backup-postgres.sh
```

### Check last night's file exists

Weekly, or after any change to the server:

```bash
sudo ls -lh /var/backups/integr8 | tail -n 3
sudo tail -n 5 /var/log/integr8-backup.log
```

The newest file is dated within the last 24 hours and is not a few hundred
bytes (an empty database dumps to a few kilobytes; a real one to megabytes).
Check it is readable:

```bash
gunzip -t /var/backups/integr8/integr8-<newest>.sql.gz && echo readable
```

## The limit, honestly

**The files sit on the same disk as the database.** They protect against a bad
migration, a deleted company or a mistaken bulk change. They do **not** protect
against losing the machine, its disk or the account that holds it: all of it,
backups included, goes at once.

The next step, not yet done, is copying each night's file somewhere else: a
cloud bucket with `rclone`, or the cloud provider's boot-volume backup policy.
Both are described in [`docs/deployment/README.md`](../deployment/README.md).
Until one of them is in place, the recovery targets below assume the machine
survives.

---

## Part 2 — rehearse a restore

**Do this before the first customer, and every six months after.** Record the
result in the table at the bottom of this file. An untimed restore procedure
means you cannot answer "how long until we are back?", which is the only
question anyone will ask.

Rehearse on the home test box (Ubuntu with Docker), never on production.

1. **Copy one dump to the test box** over SSH (`scp`), into a root-only
   directory. Delete it at the end.

2. **Note the start time.**

   ```bash
   date -u +%H:%M:%S
   ```

3. **Restore it** — see "Restoring one file into a running stack" below.

4. **Check the schema is at the expected version.**

   ```bash
   docker compose -f deploy/compose.yml --env-file deploy/.env \
     run --rm migrate node node_modules/@integr8/db/dist/migrator/cli.js status
   ```

   Every line `applied`. A `pending` line means the dump predates the running
   build: start the stack again and `migrate` applies it. Note it, because it
   tells you the backup and the deployed code were out of step.

5. **Check the data.** Row counts against what production reported:

   ```bash
   docker compose -f deploy/compose.yml --env-file deploy/.env exec postgres \
     psql -U postgres -d integr8 -c "select
       (select count(*) from tenants)      as tenants,
       (select count(*) from tenant_users) as members,
       (select count(*) from audit_log)    as audit_entries,
       (select count(*) from auth.users)   as sign_in_accounts;"
   ```

6. **Check isolation survived.** Connect as `integr8_app` and confirm the
   backstop is intact:

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

7. **Sign in** on the web app with a real account from the dump. That proves
   the `auth` schema came back with the rest.

8. **Note the finish time**, record the result below, and delete the dump and
   the test box's restored database (`docker compose down -v` on the test
   stack): it holds a full copy of customer data.

### Restoring one file into a running stack

This **replaces the database's contents**. The dump was written with `--clean`,
so it drops and recreates every object it contains.

```bash
cd /opt/integr8
compose() { docker compose -f deploy/compose.yml --env-file deploy/.env "$@"; }

# 1. Stop everything that writes, and Auth, which holds connections to its schema.
compose stop web api worker auth

# 2. Make sure the roles exist (the dump names them as owners).
compose run --rm bootstrap

# 3. Restore.
gunzip -c /var/backups/integr8/integr8-20261004-0300.sql.gz \
  | compose exec -T postgres psql -U postgres -d integr8 -v ON_ERROR_STOP=1

# 4. Start again. migrate applies anything newer than the dump; Auth checks its
#    own schema; the API waits for both.
compose up -d
```

### A real restore

Same steps, plus:

- **Take a dump of the current state first**, however broken, with
  `backup-postgres.sh`. If the restore goes wrong you still have it.
- **Choose the file deliberately.** The newest one may already contain the
  problem; a bad migration at 14:00 means last night's 03:00 file.
- **Everything after the dump is lost**, up to a day of work. Phones keep
  unsent work and send it again when they reconnect; office work typed into
  the web or desktop app since the dump is gone.
- **Write the incident up the same day**, while you remember what was confusing.

---

## Recovery objectives

| Measure                                   | Target   | Mechanism                                 |
| ----------------------------------------- | -------- | ----------------------------------------- |
| RPO — how much data we can afford to lose | 24 hours | Nightly `backup-postgres.sh`              |
| RPO if the machine is lost                | —        | Not covered until dumps are copied off it |
| RTO — how long until we are serving again | 2 hours  | This runbook, rehearsed                   |

The RTO is a claim until a rehearsal supports it. Fill in the table below.

## Rehearsal log

| Date                                          | Performed by | Source | Restore time | Data verified | Notes |
| --------------------------------------------- | ------------ | ------ | ------------ | ------------- | ----- |
| _(not yet rehearsed — see P02 exit criteria)_ |              |        |              |               |       |
