# Railway

Three services from this repository, plus Railway's own Postgres, and no
machine to look after. The step-by-step version is in
`docs/deployment/README.md`; this directory holds the per-service
configuration that Railway reads instead of dashboard settings.

| Service  | Config file   | Image                 | Runs                                                                |
| -------- | ------------- | --------------------- | ------------------------------------------------------------------- |
| `api`    | `api.json`    | `apps/api/Dockerfile` | the API; before each deploy, `migrator deploy` (roles + migrations) |
| `worker` | `worker.json` | `apps/api/Dockerfile` | the job worker                                                      |
| `web`    | `web.json`    | `apps/web/Dockerfile` | the Next.js server                                                  |

Each service is connected to the same GitHub repository with its **Railway
config file** setting pointed at one of these files (Settings → Config-as-code).
The build context is the repository root, which is what both Dockerfiles
expect.

What the files do not hold, because it is secret or environment-specific, is
variables. The API and the worker take the same set (`deploy/.env.example` is
the list); the web app takes `NEXT_PUBLIC_API_BASE_URL` (a build argument, so
it must exist before the first build), `API_BASE_URL`, `APP_ENV` and `PORT`.

Why the pre-deploy command is one command: Railway runs it inside the new image
before the deployment takes traffic, with the service's variables, and a
failed run stops the deploy. `deploy` is `bootstrap` then `up` in one process,
so the hook does not depend on a shell joining two commands.
