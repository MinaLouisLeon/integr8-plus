# Runbook — creating a Supabase environment

Takes about fifteen minutes. Run it once per environment: development, test,
staging, production.

Every step is idempotent. If you are unsure whether a step ran, run it again.

---

## What you end up with

- A Supabase project.
- A `integr8_app` role that the API connects as, subject to RLS.
- A `integr8_auth` role for the part of sign-in that happens before a company is
  known. It reaches two tables and one view and nothing else.
- The schema, applied by migrations rather than by hand.
- Two connection strings, in the right form for the two very different jobs
  they do.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Name it `integr8-<environment>` — `integr8-production`, `integr8-test`.
3. Pick the region closest to your customers. This is not changeable later.
4. Generate a strong database password and put it in your password manager
   immediately. Supabase shows it once.
5. Wait for provisioning to finish.

Record the **project ref** — the subdomain in the dashboard URL,
`https://supabase.com/dashboard/project/<PROJECT_REF>`.

## 2. Collect the two connection strings

**Project Settings → Database → Connection string.**

You need both, and they are not interchangeable.

**Direct connection** (port 5432) — this is `DATABASE_URL_ADMIN`:

```
postgres://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
```

Migrations need it. They take session-level advisory locks and run
multi-statement transactions, neither of which survives transaction-mode
pooling.

**Transaction pooler** (Supavisor, port 6543) — this becomes `DATABASE_URL`
once you have the role from step 3:

```
postgres://integr8_app.PROJECT_REF:APP_PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Note the username form: `<role>.<project_ref>`, not just the role. Supavisor
routes on the part after the dot.

> **Transaction mode, and long-lived containers.** The API keeps a pool of
> connections and holds them across requests. That is incompatible with
> serverless functions, whose cold starts would open a pool per invocation.
> Run the API on containers. This is a locked decision in `plan/README.md`, and
> the pooling mode here is the reason for it.

## 3. Create the two login roles

```bash
cd packages/db
cp .env.example .env
# Fill in DATABASE_URL_ADMIN from step 2. Leave the other two for now.

export INTEGR8_APP_PASSWORD="$(openssl rand -base64 32)"
export INTEGR8_AUTH_PASSWORD="$(openssl rand -base64 32)"
pnpm --filter @integr8/db db bootstrap
```

This creates both roles with `login`, `connect` on the database, and a
role-level `search_path` — role-level because a session-level `SET` would not
survive transaction pooling.

| Role           | Used by                            | RLS applies                                   |
| -------------- | ---------------------------------- | --------------------------------------------- |
| `integr8_app`  | Every tenant request               | Yes                                           |
| `integr8_auth` | Sign-in, before a company is known | No policy to apply — it reaches three objects |

`integr8_auth` exists because sign-in has to ask two questions that have no
tenant to scope by: is this address locked out, and which companies does this
identity belong to. Giving those to the tenant runtime role would hand every
tenant request a cross-tenant read. Instead it gets its own role with
privileges on `login_attempts`, `account_locks` and the `auth_memberships` view
— checked at startup and again by the schema-invariant suite.

Bootstrap grants nothing else. Table privileges come from the migrations, so a
table added later is invisible to both roles until someone writes its grant.
New tables fail closed.

Put both passwords in your password manager, then set `DATABASE_URL` and
`DATABASE_URL_AUTH` in `.env` using them and the pooler host from step 2.

## 4. Apply the schema

```bash
pnpm --filter @integr8/db db up
pnpm --filter @integr8/db db status
```

Every line should read `applied`. If any reads `checksum-mismatch`, stop and
read [migrations.md](./migrations.md) — someone has edited a migration that has
already run.

## 5. Verify the isolation actually holds

Do not skip this. It is the only step that proves the four preceding ones
worked, and it takes under a minute.

```bash
# In packages/db/.env
APP_ENV=test
INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable

pnpm --filter @integr8/db test:integration
```

> **Only ever against a disposable database.** The suite truncates tables. Two
> independent variables have to agree before it will run, and neither has a
> default, precisely so that this cannot happen to a database you care about.
> For a production project, run the suite against a Supabase **branch** and
> leave `INTEGR8_TEST_DATABASE` unset everywhere else.

Everything should pass. In particular the suite proves, against this database:

- No repository method returns another company's rows, with RLS switched off.
- No unfiltered raw statement crosses a tenant boundary, with the repository
  layer bypassed.
- The runtime role cannot read `platform_users`, `login_attempts`,
  `account_locks` or `auth_memberships`, and cannot write to `tenants`.
- `integr8_auth` holds no privilege on any tenant-scoped table.
- Every view in the schema is on the declared allow-list.
- `audit_log` rejects update, delete and truncate — for the owner too.
- The tenant context does not survive its transaction.

Then the authentication suite, which needs the keys from
[docs/auth/README.md](../auth/README.md):

```bash
pnpm --filter @integr8/auth test:integration
```

## 6. Seed demo data (non-production only)

```bash
pnpm --filter @integr8/db db:seed
```

Creates Northwind Facilities and Southgate Facilities, deliberately confusable:
the same person, under one auth identity and one email address, is a member of
both with a different role in each. The seed refuses to run when `APP_ENV` is
`staging` or `production`.

## 7. Turn on backups

Follow [runbook-backup-and-restore.md](./runbook-backup-and-restore.md), then
rehearse a restore. A backup nobody has restored is a hypothesis.

## 8. Enable the database job in CI

The isolation suite has to run on every pull request, or it decays into
decoration.

In **GitHub → Settings → Secrets and variables → Actions**:

| Kind     | Name                      | Value                                                 |
| -------- | ------------------------- | ----------------------------------------------------- |
| Variable | `DATABASE_TESTS`          | `enabled`                                             |
| Secret   | `TEST_DATABASE_URL`       | `integr8_app` pooler string for the **test** project  |
| Secret   | `TEST_DATABASE_URL_ADMIN` | direct owner string for the **test** project          |
| Secret   | `TEST_DATABASE_URL_AUTH`  | `integr8_auth` pooler string for the **test** project |

Point them at a disposable project or a Supabase branch. Never at production.

Until `DATABASE_TESTS` is set, the `database` job in `.github/workflows/ci.yml`
is skipped, and the P02 exit criterion "the isolation suite runs in CI" is not
met.

---

## Troubleshooting

**`Role integr8_app does not exist`** or **`Role integr8_auth does not exist`**
during `db up` — step 3 has not run against this database.

**`AuthRoleTooBroadError` at startup** — `DATABASE_URL_AUTH` is connecting as
something other than `integr8_auth`. The message lists which check failed. This
role is the one place in the system RLS cannot constrain, and what keeps that
safe is that it can reach three objects; a wider role turns the narrowest thing
in the schema into the widest.

**`RlsNotEnforcedError` at startup** — `DATABASE_URL` is connecting as the owner
rather than as `integr8_app`. The message lists which check failed. Do not work
around it; it is reporting that every RLS policy in the database is currently
inert for this connection.

**`permission denied for table <something>`** from the application — a migration
created a table without granting the runtime role access. That is the intended
default. Add the grant to the migration that created the table if it has not
shipped, or write a new migration if it has.

**Migrations hang** — another migrator holds the advisory lock. Usually a CI run.
Wait, or find it:

```sql
select pid, query, state from pg_stat_activity where application_name = 'integr8-migrator';
```
