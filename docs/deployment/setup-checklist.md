# Integr8 Plus Setup Checklist

_Integr8 Plus 2.0.0 · every step, in order · Oracle Cloud_

**From zero to running.** Every step to put Integr8 Plus on its Oracle machine, give each company its own apps, go live, and update it later. One line per step; the commands are ready to copy. Stages 1 to 9 are done once, in order; Stage 10 is every release; Stage 11 only when you want an empty machine again.

Each step says where it happens: `laptop` (PowerShell on your Windows laptop), `machine` (the SSH session on the server), `web` (a service's website: Oracle, Cloudflare, GitHub, Expo…) or `app` (the staff desktop app).

> [!TIP]
> The interactive copy, `setup-checklist.html` (open it with `setup-checklist.css` and `setup-checklist.js` beside it), remembers your ticks in the browser. What each setting does is written beside it in `deploy/.env.example`; occasional jobs (changing the HR key, moving a company to another server, code signing, the app stores, the test box) are in `docs/deployment/README.md`.

## Contents

- Stage 1 — Accounts and keys
- Stage 2 — The Oracle machine
- Stage 3 — Domain names and HTTPS
- Stage 4 — The settings file
- Stage 5 — Start the stack
- Stage 6 — You, your staff and the staff app
- Stage 7 — A new company
- Stage 8 — Apps for each company
- Stage 9 — Go live
- Stage 10 — Update to a new version
- Stage 11 — Start fresh on the machine

---

## Stage 1 — Accounts and keys

_half a day, plus DNS waits_

Create every account and collect every key before anything is installed. Keep a password manager open: several services show a secret only once, and every later stage copies from it.

- [ ] `laptop` **Install Git, Node 22 and pnpm**: then close and reopen the Terminal so the new programs are found.

```powershell
# laptop (PowerShell)
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.22 -e
npm install -g pnpm@latest-10
git config --global core.autocrlf false
```

- [ ] `laptop` **Get the repository**: Git opens a GitHub sign-in in the browser the first time.

```powershell
# laptop (PowerShell)
cd ~\Documents
git clone https://github.com/MinaLouisLeon/integr8-plus.git
cd integr8-plus
pnpm install
```

- [ ] `laptop` **Make an SSH key**: press Enter at every question. The second line copies the public half for Oracle.

```powershell
# laptop (PowerShell)
ssh-keygen -t ed25519
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

- [ ] `laptop` **Generate five passwords**: run the line five times, for `POSTGRES_PASSWORD`, `INTEGR8_APP_PASSWORD`, `INTEGR8_AUTH_PASSWORD`, `INTEGR8_PLATFORM_PASSWORD` and `BUILD_TOKEN`.

```powershell
# laptop (PowerShell)
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

- [ ] `laptop` **Generate the signing keys and sign-in secrets**: seven `NAME=value` lines open in Notepad. Copy them to the password manager, then delete the file.

```powershell
# laptop (PowerShell), in the repository folder
pnpm --silent --filter @integr8/auth keygen | Select-String '^[A-Z_]+=' | ForEach-Object Line | Set-Content -Encoding ascii $env:TEMP\integr8-keys.txt
notepad $env:TEMP\integr8-keys.txt
Remove-Item $env:TEMP\integr8-keys.txt
```

- [ ] `laptop` **Generate the HR and e-invoicing keys**: run the line twice, for `HR_DATA_KEY` and `ETA_CREDENTIALS_KEY`. Keep both for ever and keep `HR_DATA_KEY` apart from the backups: data sealed with them cannot be read without them.

```powershell
# laptop (PowerShell)
$k = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k); [Convert]::ToBase64String($k)
```

- [ ] `web` **Oracle Cloud account**: cloud.oracle.com → Start for free, with your name and address exactly as on your card. Pick the home region nearest your customers: it cannot be changed later.
- [ ] `web` **Cloudflare: the domain**: Add a domain → `integr8-media.com` → Free plan. At the registrar, replace the nameservers with the two Cloudflare shows.
- [ ] `web` **Cloudflare: R2 file storage**: R2 Object Storage → Get started. Copy the Account ID (`CLOUDFLARE_ACCOUNT_ID`), then Manage R2 API Tokens → Admin Read & Write, all buckets: `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Do not create buckets yourself.
- [ ] `web` **Cloudflare: analytics token**: your profile → API Tokens → Create Custom Token with one permission, Account · Account Analytics · Read: `CLOUDFLARE_API_TOKEN`.
- [ ] `web` **Resend, for email**: add the domain, add the DNS records it shows in Cloudflare, Verify, then an API key with Sending access: `RESEND_API_KEY`. `EMAIL_FROM` is `Integr8 Plus <info@integr8-media.com>`.
- [ ] `web` **Mapbox, for addresses**: Access tokens → Create a token: `MAPBOX_ACCESS_TOKEN`.
- [ ] `web` **Sentry, for errors**: four projects, Node.js, Next.js, React and React Native, and their DSNs: `SENTRY_DSN`, `WEB_SENTRY_DSN`, `DESKTOP_PUBLIC_SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN`.
- [ ] `web` **Expo, for the phone apps**: one account and one project named exactly `integr8-plus` for every company. Copy its Project ID and make an access token named `github-actions` (`EXPO_TOKEN`). The Project ID must match the `EAS_PROJECT_ID` line in `apps/mobile/app.config.ts`; change it through a pull request into `dev` if not.
- [ ] `web` **Firebase, for Android notifications**: one project, `integr8-plus`. Add an Android app `com.integr8.plus` and download `google-services.json`; Service accounts → Generate new private key (the FCM key). Keep both files in the password manager.
- [ ] `web` **GitHub: Actions settings**: repository → Settings → Secrets and variables → Actions. Variables: `PUBLIC_API_URL` = `https://api.integr8-media.com`, `DESKTOP_PUBLIC_SENTRY_DSN`, `EAS_BUILDS` = `enabled`. Secrets: `EXPO_TOKEN` and `BUILD_TOKEN`.
- [ ] `web` **GitHub: the server's token**: your avatar → Settings → Developer settings → Fine-grained tokens → Generate: name `integr8-releases`, only `integr8-plus`, Contents Read-only, an expiry of a year at most (put the date in your calendar). This is `GITHUB_RELEASES_TOKEN`: the server downloads the code, the download page and desktop updates with it.
- [ ] `web` **Optional: an AI provider**: only to give the assistant AI answers. An API key from OpenAI, Groq, Google Gemini or Anthropic, plus the model ids and their prices from the provider's pricing page. Without one the assistant can still answer from the help library, at no cost.

> [!WARNING]
> Four keys can read every company's data or spend money: `SUPABASE_SERVICE_ROLE_KEY`, `R2_SECRET_ACCESS_KEY`, `GITHUB_RELEASES_TOKEN` and the AI provider's key. They live only in `deploy/.env` and your password manager. If one is pasted anywhere else, replace it the same day.

---

## Stage 2 — The Oracle machine

_45 minutes_

One Always Free ARM machine runs everything: 4 cores, 24 GB, at no cost.

- [ ] `web` **Create the instance**: Compute → Instances → Create instance, named `integr8`. Image Ubuntu 24.04 (Oracle Linux 9 works too). Shape Ampere `VM.Standard.A1.Flex`, 4 OCPUs, 24 GB, marked Always Free-eligible. Public IPv4 on, paste your SSH key, boot volume 100 GB. "Out of host capacity" only means try again later.
- [ ] `web` **Give it a reserved IP**: Networking → IP Management → Reserved public IPs → Reserve. Then the instance's primary VNIC → IP addresses → ⋮ Edit → No public IP → Update, and ⋮ Edit again → Reserved public IP → yours. That address is SERVER-IP from now on.
- [ ] `web` **Open ports 80 and 443**: the machine's virtual cloud network → Default Security List → Ingress rules → Add: source `0.0.0.0/0`, TCP, destination port `80`; another rule the same for `443`.
- [ ] `web` **Upgrade to Pay As You Go**: Billing → Upgrade, so Oracle never reclaims a quiet machine. Always Free resources stay free.
- [ ] `machine` **Connect and get the code**: LOGIN-USER is `ubuntu` on Ubuntu, `opc` on Oracle Linux. When Git asks, the username is your GitHub name and the password is the server's token; it is remembered for later updates.

```powershell
# laptop (PowerShell)
ssh LOGIN-USER@SERVER-IP
```

```bash
# machine (SSH session)
sudo apt-get install -y git          # Oracle Linux: sudo dnf install -y git
sudo mkdir -p /opt/integr8 && sudo chown "$USER" /opt/integr8
git config --global credential.helper store
git clone https://github.com/MinaLouisLeon/integr8-plus.git /opt/integr8
```

- [ ] `machine` **Run the setup script**: it opens the machine's firewall, installs Docker and Caddy and turns on security updates. Log in again afterwards, then `docker compose version` answers.

```bash
# machine (SSH session)
bash /opt/integr8/deploy/vps/setup.sh
exit
```

> [!NOTE]
> **SSH says "bad permissions"?** Windows lets other accounts read the key file. In PowerShell: `icacls $env:USERPROFILE\.ssh\id_ed25519 /inheritance:r /grant:r "${env:USERNAME}:R"`, then connect again.

---

## Stage 3 — Domain names and HTTPS

_20 minutes, plus the DNS wait_

`app.` is the public site, `api.` the API. Caddy fetches and renews the certificates by itself.

- [ ] `web` **Add two DNS records**: Cloudflare → DNS → Records: type `A`, name `app`, to SERVER-IP, and the same for `api`. Proxy status DNS only (grey cloud) for both.
- [ ] `machine` **Give Caddy the names**: the file it prints must show `app.integr8-media.com` and `api.integr8-media.com`.

```bash
# machine (SSH session)
sudo cp /opt/integr8/deploy/vps/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/YOUR-DOMAIN.com/integr8-media.com/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
cat /etc/caddy/Caddyfile
```

- [ ] `laptop` **Check the padlock**: `nslookup api.integr8-media.com` shows SERVER-IP, and both addresses open in the browser with a padlock (an error page is right until Stage 5).

---

## Stage 4 — The settings file

_30 minutes_

One file, `deploy/.env`, holds every setting; it is never committed. A line starting with `#` is ignored, so take the `# ` off every line you fill. In nano, Ctrl-W searches, Ctrl-O then Enter saves, Ctrl-X leaves, and right-click pastes.

- [ ] `machine` **Start from the template**: then work down the file with the steps below.

```bash
# machine (SSH session)
cd /opt/integr8
cp deploy/.env.example deploy/.env
nano deploy/.env
```

- [ ] `machine` **Mode and addresses**: `APP_ENV=staging` for now. `PUBLIC_API_URL`, `API_PUBLIC_URL` and `AUTH_ISSUER` are `https://api.integr8-media.com`; `WEB_APP_URL` is `https://app.integr8-media.com`; `CONTACT_EMAIL` is `info@integr8-media.com`.

```text
APP_ENV=staging
PUBLIC_API_URL=https://api.integr8-media.com
API_PUBLIC_URL=https://api.integr8-media.com
WEB_APP_URL=https://app.integr8-media.com
API_CORS_ORIGINS=https://app.integr8-media.com,tauri://localhost,http://tauri.localhost
CONTACT_EMAIL=info@integr8-media.com
```

- [ ] `machine` **Releases and the build token**: `APP_RELEASES=github`, `GITHUB_RELEASES_REPOSITORY=minalouisleon/integr8-plus`, `GITHUB_RELEASES_TOKEN` = the server's token, `BUILD_TOKEN` = the same value as the GitHub secret. Leave the three `APP_BUILDS` lines commented out (Stage 8).
- [ ] `machine` **Database passwords**: each of the four passwords goes on two lines, its own and the `change-me` part of its address.

```text
POSTGRES_PASSWORD=aaaa…
DATABASE_URL_ADMIN=postgres://postgres:aaaa…@postgres:5432/integr8
INTEGR8_APP_PASSWORD=bbbb…
DATABASE_URL=postgres://integr8_app:bbbb…@postgres:5432/integr8
INTEGR8_AUTH_PASSWORD=cccc…
DATABASE_URL_AUTH=postgres://integr8_auth:cccc…@postgres:5432/integr8
INTEGR8_PLATFORM_PASSWORD=dddd…
DATABASE_URL_PLATFORM=postgres://integr8_platform:dddd…@postgres:5432/integr8
```

- [ ] `machine` **Keys and secrets**: paste the seven generated lines over the empty lines of the same names, then `HR_DATA_KEY` and `ETA_CREDENTIALS_KEY`. Each value stays on one line. Leave `ETA_ALLOW_PRODUCTION=false`.
- [ ] `machine` **Sentry and the version**: `SENTRY_DSN` is the Node.js DSN; `WEB_SENTRY_DSN` and `WEB_PUBLIC_SENTRY_DSN` are both the Next.js DSN. `APP_VERSION` and `API_RELEASE` say `2.0.0`.
- [ ] `machine` **The real services**: switch each one from its stand-in and fill its lines. Leave `PDF_RENDERER=chromium` as it is.

```text
MEDIA_STORAGE=r2
CLOUDFLARE_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET_PREFIX=integr8-production
CLOUDFLARE_API_TOKEN=…
GEOCODER=mapbox
MAPBOX_ACCESS_TOKEN=pk.…
PUSH_SENDER=expo
EMAIL_SENDER=resend
RESEND_API_KEY=re_…
EMAIL_FROM=Integr8 Plus <info@integr8-media.com>
```

- [ ] `machine` **Optional: the assistant**: leave `AI_ENABLED=false` to keep it off. Help library only, no AI: `AI_ENABLED=true` and `AI_PROVIDER=none`. With a provider: its name, its key line, the three `AI_MODEL_` lines and `AI_MODEL_PRICES`, as in the template's example.
- [ ] `machine` **Check for example values**: fix every setting it names and run it again until it says `no example values left`.

```bash
# machine (SSH session)
sh deploy/vps/check-env.sh
```

> [!WARNING]
> **A password pair that does not match** stops Stage 5 with `password authentication failed`. Postgres keeps the first password it was given, so after fixing it run `docker compose -f deploy/compose.yml --env-file deploy/.env down -v` before starting again. Only ever before there is real data.

---

## Stage 5 — Start the stack

_15 minutes, mostly building_

The first start builds the images on the machine, then creates the database and starts everything. The containers start again by themselves after a reboot.

- [ ] `machine` **Build and start**: Ctrl-C leaves the logs; the containers keep running.

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f bootstrap migrate auth api
```

- [ ] `machine` **The API is ready**: it answers `"status":"ready"`; otherwise the answer names what is failing.

```bash
# machine (SSH session)
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] `machine` **Every container is up**: `auth` and `api` say Up (healthy); `bootstrap` and `migrate` say Exited (0). `logs api` names any setting that is wrong.

```bash
# machine (SSH session)
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

- [ ] `machine` **File storage works**: it reaches R2 and finishes without an error.

```bash
# machine (SSH session)
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/media/storage-cli.js provision --all
```

- [ ] `web` **The public site opens**: `https://app.integr8-media.com` shows the landing page with a padlock. Nobody signs in there: staff and companies work in their desktop apps.

---

## Stage 6 — You, your staff and the staff app

_1 hour, mostly waiting_

Integr8 staff run everything from the staff desktop app. GitHub builds it at every release; nothing is built on your laptop.

- [ ] `machine` **Create your staff account**: save the password and the authenticator secret it prints once, and add the secret to your authenticator app. Accounts made here are staff managers, the only ones who can add or remove colleagues.

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js create you@integr8-media.com "Your Name"
```

- [ ] `web` **The updater key in GitHub**: secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of `updater.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, so installed desktop apps update themselves. If nobody has the key, make a new pair with `pnpm --filter @integr8/desktop tauri signer generate -w src-tauri/updater.key` and put its public half in `updater.key.pub` and `tauri.conf.json` through a pull request.
- [ ] `web` **A release on GitHub**: Releases shows `v2.0.0` (or newer) with green jobs. If not, bump the version in the root `package.json` and merge it through `dev` and `staging` into `main`, then wait for Version release to finish green (about 30 minutes).
- [ ] `app` **Install the staff app**: Releases → the newest `v…` → Assets → the Integr8 Plus Staff `-setup.exe`. Until the installers are signed, Windows warns: More info → Run anyway.
- [ ] `app` **Sign in**: email, password and the six-digit code, asked each time the app starts. Health is empty and Templates lists the form library.
- [ ] `app` **Add your colleagues**: Staff → Add a staff member. Send them the details it shows once, privately, then press I have sent them. Keep at least two staff managers made on the machine.
- [ ] `app` **The plans**: Plans → Change: each plan's list price, if you show one. With the assistant on, each plan's AI level and limits too; every plan starts Off.

---

## Stage 7 — A new company

_45 minutes per company_

You create every company and make it ready before its owner arrives. Repeat this stage for each new company.

- [ ] `app` **Onboard it**: Companies → Onboard a company: name, short name, plan, seats, the owner's email, its website and the menu tabs it gets. The owner's invitation waits until the company's own desktop app exists.
- [ ] `app` **Switch on its modules**: the company's page → Features: only what it bought (`crm`, `sales`, `finance`, `ledger`, `inventory`, `purchasing`, `assets`, `hr`, `payroll`, `manufacturing`, `documents`). Leave `e_invoicing` off: it is test-only.
- [ ] `app` **Work inside the company**: the company's page → Work inside this company → a reason → Start. A red banner shows you are acting as the company; Back to the dashboard leaves.
- [ ] `app` **Give it its look**: Set-up → Company branding: logo, a square app icon of at least 512 × 512, colours and theme. The company's apps wear them.
- [ ] `app` **Build its forms and job types**: rename the job types, build forms from the templates, attach them to job types and publish. PDF templates too, when Documents is on.
- [ ] `app` **Switch its apps on**: Back to the dashboard → the company's page → Website and apps → Build apps for this company → Save. Then Stage 8.
- [ ] `app` **Invite the owner**: once the company's release exists, the company's page → Invitations → Send invitation. The owner sets a password from the email and signs in to the company's desktop app.
- [ ] `app` **Optional: the assistant**: Website and apps → Assistant in desktop app and in mobile app. For AI answers the owner gives each person a share under People.

---

## Stage 8 — Apps for each company

_25 minutes per company, mostly waiting_

Each company gets desktop installers and a phone app with its own name, icon and colours. One Expo project and one Firebase project serve them all.

> [!NOTE]
> **The Android package** is `com.integr8.plus.` plus the short name with `-` turned into `_`: `al-noor` becomes `com.integr8.plus.al_noor`. A short name starting with a digit gets a `c` in front.

- [ ] `web` **Expo settings, once**: expo.dev → `integr8-plus` → Environment variables, for production: `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` (the machine's `AUTH_VERIFICATION_KEYS` value) and `GOOGLE_SERVICES_JSON` as a File.
- [ ] `web` **Add the company in Firebase**: Project settings → Add app → Android, the company's package. Download `google-services.json` again (it now lists every company) and replace the `GOOGLE_SERVICES_JSON` file on Expo.
- [ ] `web` **Start the build**: GitHub → Actions → Build company apps → Run workflow on `main`, company = the short name (`all` builds every company with apps on); leave the rest empty. About 25 minutes later Releases has `company-<short name>-v2.0.0`.
- [ ] `web` **Optional: start builds from the staff app**: a fine-grained token `integr8-app-builds` on `integr8-plus` with Actions Read and write. In `deploy/.env`: `APP_BUILDS=github`, `GITHUB_BUILD_TOKEN` = the token, `GITHUB_BUILD_REPOSITORY=minalouisleon/integr8-plus`, then `up -d`. Rebuild apps on the company's page then starts it.
- [ ] `web` **Notifications for its phone app**: after its first build, expo.dev → Credentials → Android → the company's app → FCM V1 service account key: upload the FCM key the first time, choose the same key after.
- [ ] `web` **Hand the apps over**: send the company `https://app.integr8-media.com/download?company=<short name>`, with the Windows note (More info → Run anyway). Every new release rebuilds their apps by itself.
- [ ] `app` **Try one job end to end**: the owner adds a customer, a site and a job and invites an engineer under People; the engineer finishes it on the phone in aeroplane mode with a photo, and it reaches the office once back online.

---

## Stage 9 — Go live

_2 hours_

Production mode, backups that leave the machine, and an alert when something stops.

- [ ] `machine` **Switch to production**: set `APP_ENV=production` in `deploy/.env`, then restart. The log must not say "Refusing to start in production"; if it does, it names what to fix.

```bash
# machine (SSH session)
cd /opt/integr8
sh deploy/vps/check-env.sh
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
docker compose -f deploy/compose.yml --env-file deploy/.env logs api | head -40
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] `machine` **A nightly backup**: `sudo crontab -e` and add this line. It keeps fourteen dumps in `/home/integr8-backup`.

```bash
# machine, one line inside the crontab editor
0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
```

- [ ] `web` **A bucket for off-machine copies**: Cloudflare → R2 → Create bucket `integr8-backups`. Then an API token `integr8-backups` with Object Read & Write on that bucket only; copy its two keys (not the media token, which can delete every company's files).
- [ ] `machine` **An encryption passphrase**: run `openssl rand -base64 32` and save the result beside `HR_DATA_KEY`. Without it nobody can read the copies, you included.
- [ ] `machine` **Connect rclone to the bucket**: replace the capitals with the token's keys, your Cloudflare Account ID and the passphrase. The last line lists nothing yet, with no error.

```bash
# machine (SSH session)
sudo apt-get install -y rclone
sudo rclone config create r2 s3 provider=Cloudflare \
  access_key_id=ACCESS-KEY-ID secret_access_key=SECRET-ACCESS-KEY \
  endpoint=https://ACCOUNT-ID.r2.cloudflarestorage.com no_check_bucket=true
sudo rclone config create r2crypt crypt remote=r2:integr8-backups \
  filename_encryption=off password=PASSPHRASE --obscure
sudo rclone lsf r2crypt:
```

- [ ] `machine` **Copy every backup there**: add `BACKUP_REMOTE=r2crypt:` to `deploy/.env`, then run a backup by hand. Its last lines say `copied … to r2crypt:` and `keeping 30 on r2crypt:`.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/backup-postgres.sh
```

- [ ] `machine` **Rehearse a restore**: it restores the newest copy from R2 into a throwaway container and never touches the live database. Do it monthly.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/restore-drill.sh --remote
```

- [ ] `machine` **Two heartbeats**: two monitors at healthchecks.io or Better Stack, one daily for the backup (`BACKUP_PING_URL`) and one every 5 minutes for the API (`HEALTH_PING_URL`), both in `deploy/.env`. Then this cron line with `sudo crontab -e`.

```bash
# machine, one line inside the crontab editor
*/5 * * * * /opt/integr8/deploy/vps/heartbeat.sh >> /var/log/integr8-heartbeat.log 2>&1
```

- [ ] `web` **Boot-volume backups**: Oracle → Block Storage → Boot Volumes → the volume → Backup policy → Bronze.
- [ ] `machine` **Reboot test**: after `sudo reboot` the whole stack is back by itself within two minutes and the API answers ready.
- [ ] `app` **Every week, five minutes**: the staff app's Health page, a look at Sentry, last night's backup log says `copied`, and `df -h` shows room on the disk.

---

## Stage 10 — Update to a new version

_30 minutes, each release_

Untick this stage (the stage's own Clear button) each time you update. Pick a quiet hour: the API is away for about a minute, and phones queue their work meanwhile.

- [ ] `web` **Make the release**: bump the version in the root `package.json`, merge through `dev` and `staging` into `main`, and wait for Version release to finish green. Read the release notes for new settings and migrations.
- [ ] `machine` **Back up first**: the newest file has today's date; keep at least 5 GB free.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lh /home/integr8-backup | tail -3
df -h /
```

- [ ] `machine` **Get the new code and new settings**: the `comm` line prints settings the new version expects that your file lacks; add each one from `deploy/.env.example`. Put the real version number in the `sed` line.

```bash
# machine (SSH session)
cd /opt/integr8
git pull
comm -13 <(grep -oE '^[A-Z_0-9]+=' deploy/.env | sort -u) <(grep -oE '^[A-Z_0-9]+=' deploy/.env.example | sort -u)
sed -i 's/^APP_VERSION=.*/APP_VERSION=2.0.0/; s/^API_RELEASE=.*/API_RELEASE=2.0.0/' deploy/.env
```

- [ ] `machine` **Restart on the new version**: it builds the images, runs any new migrations, then starts everything again.

```bash
# machine (SSH session)
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
```

- [ ] `machine` **Check it worked**: every service Up, the API ready, the staff app's Health page quiet, and Sentry quiet for half an hour.

```bash
# machine (SSH session)
docker compose -f deploy/compose.yml --env-file deploy/.env ps
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] `app` **The apps**: installed desktop apps offer Install now themselves, phones take the update over the air, and the release rebuilt every company's apps.
- [ ] `machine` **Monthly: the machine itself**: operating system, Docker and Caddy. Reboot if it says so. (Oracle Linux: `sudo dnf upgrade -y` instead of the first two lines.)

```bash
# machine (SSH session)
sudo apt-get update
sudo apt-get upgrade -y
sudo caddy upgrade && sudo systemctl restart caddy
[ -f /var/run/reboot-required ] && echo "Reboot needed" || echo "No reboot needed"
```

- [ ] `machine` **Clean up the next day**: old images only. Never prune volumes: the database lives in one.

```bash
# machine (SSH session)
docker image prune -f
docker builder prune -f
```

- [ ] `machine` **If something goes wrong**: go back to the previous release's tag; it starts on the newer database as it is. Put its real number in both lines.

```bash
# machine (SSH session)
cd /opt/integr8
git fetch --tags
git checkout v2.0.0
sed -i 's/^APP_VERSION=.*/APP_VERSION=2.0.0/; s/^API_RELEASE=.*/API_RELEASE=2.0.0/' deploy/.env
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

---

## Stage 11 — Start fresh on the machine

_30 minutes, then Stages 6 to 8 again_

Deletes Integr8's containers, images and database, then starts again on an empty one. Every company, staff account and sign-in on this machine is lost; the machine, Caddy, `deploy/.env` and every key stay.

- [ ] `machine` **Back up first**: even when nothing is meant to be kept, it is the only way back.

```bash
# machine (SSH session)
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lh /home/integr8-backup | tail -3
```

- [ ] `laptop` **Copy the backup and the settings to the laptop**: use the real file name from the step before.

```powershell
# laptop (PowerShell)
scp LOGIN-USER@SERVER-IP:/home/integr8-backup/integr8-YYYYMMDD-HHMM.sql.gz .
scp LOGIN-USER@SERVER-IP:/opt/integr8/deploy/.env ./integr8-env-backup
```

- [ ] `machine` **Delete the stack and its data**: `down -v` deletes the database volume and `--rmi all` the images. Other projects on the machine are not touched.

```bash
# machine (SSH session)
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env down -v --rmi all --remove-orphans
docker builder prune -af
```

- [ ] `machine` **Start again on the newest code**: then check `APP_VERSION` and `API_RELEASE` match the release, and do Stage 5's checks.

```bash
# machine (SSH session)
cd /opt/integr8
git checkout main && git pull
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

- [ ] `machine` **Your staff account again**: Stage 6's first step, then onboard the companies again (Stage 7).
- [ ] `web` **Optional: old companies' files**: their R2 buckets are no longer used. Cloudflare → R2 → each old `integr8-production-…` bucket → Delete (never `integr8-backups`).

---

## About this page

Written for release 2.0.0 from `deploy/compose.yml`, `deploy/.env.example` and `deploy/vps/`. The Markdown and `setup-checklist.html` say the same thing; `pnpm guide:check` checks their stages, steps and words. The longer guide this replaces is in git history.
