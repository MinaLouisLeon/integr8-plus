# Runbook — backup and restore

The database is the compose stack's own Postgres (`deploy/compose.yml`), on the
same machine as the API. There is no managed provider behind it, so there are
no backups unless this runbook sets them up.

A backup nobody has restored is a hypothesis. This runbook has three parts:
scheduling the nightly dump, which takes ten minutes; copying each dump off
the machine, which takes twenty; and rehearsing a restore, which is the part
that matters.

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

| Setting       | Default                        | Meaning                                                 |
| ------------- | ------------------------------ | ------------------------------------------------------- |
| Files         | `/var/backups/integr8`         | `BACKUP_DIR`; the directory is `0700`                   |
| Name          | `integr8-YYYYMMDD-HHMM.sql.gz` | UTC time of the dump                                    |
| Kept          | 14                             | `KEEP`; older files are deleted                         |
| Repo path     | `/opt/integr8`                 | `INTEGR8_DIR`; where compose.yml is                     |
| Off-machine   | none                           | `BACKUP_REMOTE` in `deploy/.env`: an rclone remote path |
| Kept there    | 30                             | `BACKUP_REMOTE_KEEP` in `deploy/.env`                   |
| Heartbeat URL | none                           | `BACKUP_PING_URL` in `deploy/.env`                      |

The last three are read from `deploy/.env` (an environment variable of the same
name wins), one line each, with no quotes needed. The script reads only those
lines; it never runs the file.

> **A dump contains every customer's data and every password hash.** It is the
> most sensitive file the company holds. Keep the directory readable by root
> only, encrypt the off-machine copy (Part 2 does), and never copy a dump to a
> laptop or a chat.

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

Until Part 2 is done, every run ends with
`BACKUP_REMOTE is not set: backups are on this machine only and are lost with it`.

### Check last night's file exists

Weekly, or after any change to the server:

```bash
sudo ls -lh /var/backups/integr8 | tail -n 3
sudo tail -n 5 /var/log/integr8-backup.log
```

The newest file is dated within the last 24 hours and is not a few hundred
bytes (an empty database dumps to a few kilobytes; a real one to megabytes).
The log's last lines say `copied … to …` and `keeping …`, not `ERROR`. Check
the file is readable:

```bash
gunzip -t /var/backups/integr8/integr8-<newest>.sql.gz && echo readable
```

## Part 2 — copy each dump off the machine

**The local files sit on the same disk as the database.** They protect against
a bad migration, a deleted company or a mistaken bulk change. They do **not**
protect against losing the machine, its disk or the account that holds it: all
of it, backups included, goes at once.

With `BACKUP_REMOTE` set, the script copies each night's file with
[rclone](https://rclone.org) after writing it, then keeps the newest
`BACKUP_REMOTE_KEEP` copies there and deletes older ones. It only ever deletes
files with its own `integr8-YYYYMMDD-HHMM.sql.gz` names, so anything else in
the bucket is left alone. The recommended remote is a Cloudflare R2 bucket of
its own, behind rclone's `crypt` layer, so Cloudflare holds only ciphertext.

### Set it up

1. **A bucket and a token of its own.** Cloudflare dashboard → **R2 Object
   Storage** → **Create bucket**, named `integr8-backups`. Then **Manage API
   tokens** → **Create API token**: name `integr8-backups`, permission
   **Object Read & Write**, applied to the `integr8-backups` bucket only, no
   expiry. Copy the Access Key ID and the Secret Access Key (shown once). Do not
   reuse the media token: that one can delete every company's bucket, and this
   one should be able to touch nothing but backups.

2. **A passphrase**, made on the machine and kept in the password manager
   beside `HR_DATA_KEY` before going further. Without it the copies cannot be
   read, by anyone, ever.

   ```bash
   openssl rand -base64 32
   ```

3. **rclone, and two remotes** (as root, because the nightly job runs as root
   and reads root's rclone configuration). On Ubuntu `apt` has it; elsewhere,
   rclone.org/install. Replace the capitals with the token's values, your
   Cloudflare account ID and the passphrase:

   ```bash
   sudo apt-get install -y rclone
   sudo rclone config create r2 s3 provider=Cloudflare \
     access_key_id=ACCESS-KEY-ID secret_access_key=SECRET-ACCESS-KEY \
     endpoint=https://ACCOUNT-ID.r2.cloudflarestorage.com no_check_bucket=true
   sudo rclone config create r2crypt crypt remote=r2:integr8-backups \
     filename_encryption=off password=PASSPHRASE --obscure
   sudo rclone lsf r2crypt:     # no error, and nothing listed yet
   ```

   `no_check_bucket` is needed because the token cannot create buckets.
   `filename_encryption=off` keeps the dates readable in Cloudflare's bucket
   view (`integr8-20261101-0300.sql.gz.bin`); the contents are encrypted.

4. **Tell the backup where to copy.** In `deploy/.env`:

   ```bash
   BACKUP_REMOTE=r2crypt:
   # BACKUP_REMOTE_KEEP=30
   ```

5. **Run it by hand** and read the last lines:

   ```bash
   sudo /opt/integr8/deploy/vps/backup-postgres.sh
   ```

   They end with `copied integr8-….sql.gz to r2crypt:` and
   `keeping 30 on r2crypt: (removed 0)`. Then prove the copy restores: Part 3's
   drill with `--remote`.

### When the copy fails

The dump is written and kept on the machine first, so a failed copy loses
nothing. But the run then ends with a line starting `ERROR:` that names what
failed (`could not copy … it is on this machine only`, `rclone is not
installed`, `could not delete the old copy …`) and exits with status 1. A
broken remote is never a quiet success.

### A heartbeat, so a missed night is noticed

Cron writes to a log nobody reads every day. Set `BACKUP_PING_URL` to a
heartbeat monitor's URL (Better Stack → **Heartbeats**, or healthchecks.io;
both have free tiers), expecting a ping every day with a grace period of a few
hours. The script calls it after every successful night and calls the same URL
with `/fail` on the end when a night fails, so you hear about a failed backup
at once, and about a backup that did not run at all when the grace period
ends.

### The boot-volume backup, as well

Oracle can also back up the machine's whole boot volume on a schedule: Block
Storage → Boot Volumes → the volume → **Backup policy** → Bronze. Check the
schedule the console shows for the policy you pick; it is not nightly. It is a
useful second layer, and the fastest way back after a broken operating system,
but it lives in the same Oracle account as the machine: it does not survive
losing the account, and it is not a replacement for the R2 copy.

### Getting a copy back

On any machine with rclone and the same two remotes (step 3 again, with the
same passphrase):

```bash
sudo rclone lsf r2crypt:                                    # every copy, by date
sudo rclone copy r2crypt:integr8-20261101-0300.sql.gz /var/backups/integr8/
```

The file is then an ordinary dump: restore it as in Part 3.

## Part 3 — rehearse a restore

An untimed restore procedure means you cannot answer "how long until we are
back?", which is the only question anyone will ask. There are two rehearsals: a
drill that takes minutes and can run on the live machine, and a full rehearsal
on the test box.

### The drill, monthly

`deploy/vps/restore-drill.sh` restores a dump into a **throwaway Postgres
container** and checks what came back. It never touches the live database: the
container is started from the Postgres image directly, not through compose,
with its own name, no network, no published port and none of the stack's
volumes, and it is removed with its data when the drill ends, whether it
passed or not.

```bash
sudo /opt/integr8/deploy/vps/restore-drill.sh --remote     # the newest off-machine copy
sudo /opt/integr8/deploy/vps/restore-drill.sh              # the newest dump on this machine
sudo /opt/integr8/deploy/vps/restore-drill.sh FILE.sql.gz  # that dump
```

`--remote` downloads through rclone exactly as a new machine would, so it
proves the off-machine copy as well as the dump; prefer it. The drill checks:

- the file is whole gzip, and restores with no error;
- the latest applied migration, compared with the checkout's newest (a dump
  behind the code is fine: `migrate` brings it forward on a real restore);
- companies, members, audit entries and sign-in accounts, which should look
  like production's;
- row-level security policies and the runtime role's grants came back. If
  either is missing it fails: such a restore must not serve traffic.

It needs free disk for one more copy of the database, and uses the machine for
as long as the restore takes, so pick a quiet hour. It ends by printing a row
for the [rehearsal log](#rehearsal-log): paste it there, with anything odd in
the notes. A drill that fails exits with status 1 and a line starting
`DRILL FAILED:`.

### The full rehearsal, every six months

**Do this before the first customer, and every six months after.** The drill
proves the data comes back; this proves the product works on it. Rehearse on
the home test box (Ubuntu with Docker), never on production.

1. **Copy one dump to the test box** over SSH (`scp`), into a root-only
   directory, or fetch one there with rclone ("Getting a copy back"). Delete it
   at the end.

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

Stop `web`, `api`, `worker` and `auth` first, every time: the API and worker
write to `public`, Auth writes sign-ins and sessions to `auth`, and a restore
that runs under any of them ends with a mix of the dump and whatever they
wrote meanwhile. Stopping `web` keeps people from working in a half-restored
app. The setup guide's rollback (Stage 11, part I) uses the same list.

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

| Measure                                   | Target   | Mechanism                                            |
| ----------------------------------------- | -------- | ---------------------------------------------------- |
| RPO — how much data we can afford to lose | 24 hours | Nightly `backup-postgres.sh`                         |
| RPO if the machine is lost                | 24 hours | The same file, copied off the machine (Part 2)       |
| RTO — how long until we are serving again | 2 hours  | This runbook, rehearsed; the drill times the restore |

The machine-loss RPO holds only once `BACKUP_REMOTE` is set and the nightly log
says `copied`. The RTO is a claim until a rehearsal supports it. Fill in the
table below.

## Rehearsal log

`restore-drill.sh` prints a row in this shape; the full rehearsal is written by
hand.

| Date                                                                    | Performed by | Source | Restore time | Data verified | Notes |
| ----------------------------------------------------------------------- | ------------ | ------ | ------------ | ------------- | ----- |
| _(not yet rehearsed — run `deploy/vps/restore-drill.sh --remote`; P19)_ |              |        |              |               |       |
