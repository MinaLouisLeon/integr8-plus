# Integr8 Plus Setup Checklist

_Setup checklist · version 1.4.0_

Every step to put Integr8 Plus on its Oracle machine, give each company its own apps, go live and update it later. Tick each step as you finish it. The same checklist is a page that remembers your ticks: `setup-checklist.html`, with its `.css` and `.js` beside it.

**Where to type it.** `laptop` is PowerShell on your Windows laptop, `machine` is the SSH session on the server, and `website` is a service's own website.

## Stage 1 — Accounts and keys

_Half a day._ Create every account and collect every key before anything is installed. Keep a password manager open: several services show a secret only once.

- [ ] **Install Git, Node 22 and pnpm** (laptop): Then close and reopen the Terminal so the new programs are found.

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.22 -e
npm install -g pnpm@latest-10
git config --global core.autocrlf false
```

- [ ] **Get the repository** (laptop): The repository is private: Git opens a GitHub sign-in in the browser the first time.

```powershell
cd ~\Documents
git clone https://github.com/MinaLouisLeon/integr8-plus.git
cd integr8-plus
pnpm install
```

- [ ] **Make an SSH key** (laptop): Press Enter at every question. The second line copies the public half for Oracle.

```powershell
ssh-keygen -t ed25519
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

- [ ] **Generate the passwords** (laptop): Run it five times: POSTGRES_PASSWORD, INTEGR8_APP_PASSWORD, INTEGR8_AUTH_PASSWORD, INTEGR8_PLATFORM_PASSWORD and BUILD_TOKEN.

```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

- [ ] **Generate the signing keys and sign-in secrets** (laptop): Seven lines open in Notepad. Copy them to the password manager, then delete the file.

```powershell
pnpm --silent --filter @integr8/auth keygen | Select-String '^[A-Z_]+=' | ForEach-Object Line | Set-Content -Encoding ascii $env:TEMP\integr8-keys.txt
notepad $env:TEMP\integr8-keys.txt
Remove-Item $env:TEMP\integr8-keys.txt
```

- [ ] **Generate the HR and e-invoicing keys** (laptop): Run it twice: HR_DATA_KEY and ETA_CREDENTIALS_KEY. Keep HR_DATA_KEY apart from the backups.

```powershell
$k = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k); [Convert]::ToBase64String($k)
```

- [ ] **Oracle Cloud account** (website): cloud.oracle.com, with your name exactly as on your card. Pick the home region nearest your customers: it cannot be changed.

- [ ] **Cloudflare: domain and R2** (website): Add integr8-media.com and point the registrar at Cloudflare's two nameservers. Turn on R2, copy the Account ID and make an R2 token (Admin Read & Write).

- [ ] **Cloudflare: analytics token** (website): Profile → API Tokens → custom token with Account Analytics: Read only. Key: CLOUDFLARE_API_TOKEN.

- [ ] **Resend, for email** (website): Add the domain, add its DNS records in Cloudflare, verify, then make a sending key. Keys: RESEND_API_KEY and EMAIL_FROM.

- [ ] **Mapbox and Sentry** (website): A Mapbox token (MAPBOX_ACCESS_TOKEN). Four Sentry projects: Node.js, Next.js, React and React Native, and their DSNs.

- [ ] **Expo account and project** (website): One account and one project named exactly integr8-plus for every company. Copy its Project ID and make an access token (EXPO_TOKEN).

- [ ] **Firebase project, for phone notifications** (website): One project for every company. Add the Android app com.integr8.plus, download google-services.json, and generate a service account private key (the FCM key).

- [ ] **GitHub settings** (website): Settings → Secrets and variables → Actions. Variables: PUBLIC_API_URL, DESKTOP_PUBLIC_SENTRY_DSN, EAS_BUILDS = enabled. Secrets: EXPO_TOKEN, BUILD_TOKEN. The repository is private, so builds use your monthly Actions minutes (macOS counts ten times).

- [ ] **GitHub token for the server** (website): Fine-grained token, only integr8-plus, Contents: Read-only. The server uses it to download the code and for the download page (GITHUB_RELEASES_TOKEN). Note its expiry date.

- [ ] **Optional: AI provider and Stripe** (website): Only if you turn the assistant on (OpenAI, Groq, Gemini or Anthropic key) or companies pay by card in the app. Otherwise skip.

## Stage 2 — The Oracle machine

_45 min._ One Always Free ARM machine runs everything.

- [ ] **Create the instance** (website): Compute → Instances → Create, name integr8. Shape Ampere VM.Standard.A1.Flex, 4 OCPUs, 24 GB. Paste your SSH key, boot volume 100 GB.

- [ ] **Give it a reserved IP** (website): Reserve a public IP, set the VNIC's public IP to none, then to the reserved one. That address is SERVER-IP from now on.

- [ ] **Open ports 80 and 443** (website): The network's Default Security List → Add Ingress Rules: TCP 80 and TCP 443 from 0.0.0.0/0.

- [ ] **Connect and get the code** (machine): LOGIN-USER is ubuntu on Ubuntu, opc on Oracle Linux. When Git asks, the username is your GitHub name and the password is the server token; the helper remembers it for later updates.

```bash
ssh LOGIN-USER@SERVER-IP
sudo mkdir -p /opt/integr8 && sudo chown "$USER" /opt/integr8
git config --global credential.helper store
git clone https://github.com/MinaLouisLeon/integr8-plus.git /opt/integr8
```

- [ ] **Run the setup script** (machine): Opens the machine's firewall, installs Docker and Caddy and turns on security updates. Log in again afterwards.

```bash
bash /opt/integr8/deploy/vps/setup.sh
exit
```

## Stage 3 — Two names with HTTPS

_20 min._ app. for the web app, api. for the API. Caddy gets the certificates by itself.

- [ ] **Add two DNS records** (website): Cloudflare → DNS: type A, names app and api, both to SERVER-IP, proxy status DNS only (grey cloud).

- [ ] **Give Caddy the names** (machine): The file must show app.integr8-media.com and api.integr8-media.com.

```bash
sudo cp /opt/integr8/deploy/vps/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/YOUR-DOMAIN.com/integr8-media.com/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
cat /etc/caddy/Caddyfile
```

- [ ] **Check the padlock** (laptop): nslookup api.integr8-media.com shows SERVER-IP, and both addresses open in the browser with a padlock (an error page is fine for now).

## Stage 4 — The settings file

_30 min._ One file, deploy/.env, holds every setting. It is never committed.

- [ ] **Start from the template** (machine): nano: Ctrl-W searches, Ctrl-O then Enter saves, Ctrl-X leaves; right-click pastes.

```bash
cd /opt/integr8
cp deploy/.env.example deploy/.env
nano deploy/.env
```

- [ ] **Fill it from your keys** (machine): APP_ENV=staging for now. The addresses, the passwords (each on two lines), the signing keys, R2, Resend, Mapbox, Sentry, HR_DATA_KEY. Take the # off every line you fill.

- [ ] **Private repository settings** (machine): GITHUB_RELEASES_REPOSITORY=minalouisleon/integr8-plus and GITHUB_RELEASES_TOKEN = the server token. Without it the download page and desktop updates stay empty.

- [ ] **Push notifications** (machine): PUSH_SENDER=expo. Add EXPO_ACCESS_TOKEN only if push security is switched on in your Expo account.

- [ ] **Check for example values** (machine): Repeat until it says no example values left.

```bash
sh deploy/vps/check-env.sh
```

## Stage 5 — Start the stack

_15 min._ The first start builds the images on the machine; ten to fifteen minutes.

- [ ] **Build and start** (machine): Ctrl-C leaves the logs; the containers keep running and start again after a reboot.

```bash
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f bootstrap migrate auth api
```

- [ ] **The API is ready** (machine): It answers "status":"ready". If not, the answer names what is failing.

```bash
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] **Every container is up** (machine): auth says Up (healthy); bootstrap and migrate say Exited (0).

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

- [ ] **Storage works** (machine): Makes sure the worker can reach R2.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/media/storage-cli.js provision --all
```

- [ ] **The website opens** (website): https://app.integr8-media.com shows the landing page with a padlock.

## Stage 6 — You and your staff

_30 min._ The staff dashboard is at /platform. The first account is made on the machine.

- [ ] **Create your staff account** (machine): Save the password and the authenticator secret it prints once; add the secret to your authenticator app.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/platform/admin-cli.js create you@integr8-media.com "Your Name"
```

- [ ] **Sign in to the dashboard** (website): app.integr8-media.com/platform/sign-in with email, password and the six-digit code. Health should be empty and Templates should list the form library.

- [ ] **Add your colleagues** (website): Dashboard → Staff → Add a staff member. Send them their details privately. Keep at least two staff managers made from the machine.

- [ ] **Download the staff apps** (website): Dashboard → Downloads: the staff desktop app and Integr8 Forms for AI. Only signed-in staff see them; the public /download page lists companies' apps only.

## Stage 7 — The staff desktop app

_1 hour, mostly waiting._ GitHub builds it at every release. Nothing is built on your laptop.

- [ ] **Updater key in GitHub** (website): Secrets TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, so installed apps update themselves.

- [ ] **Make a release** (website): Bump the version in the root package.json and merge into main through dev and staging. Wait for Version release to finish green.

- [ ] **Install and sign in** (website): Dashboard → Downloads → the Windows -setup.exe. Windows warns before unsigned apps: More info → Run anyway. Sign in with your staff account.

## Stage 8 — A company

_45 min._ Every company is created by you, ready to use before its owner arrives.

- [ ] **Onboard it** (website): Dashboard → Companies → Onboard a company: name, short name, plan, seats, billing, owner's email, website, and the menu tabs it gets. Leave the invitation unsent for now.

- [ ] **Switch on its modules** (website): The company's page → Features: only the modules it bought (CRM, sales, finance, inventory, HR and the rest).

- [ ] **Set its look** (website): Staff desktop app → Company branding: logo, app icon, colours and theme.

- [ ] **Build its forms and job types** (website): Staff desktop app → the form builder and the job types; PDF templates if it has Documents.

- [ ] **Invite the owner** (website): The company's page → Invitations → Send invitation.

## Stage 9 — Apps for each company

_25 min per company._ Each company gets desktop installers and a phone app with its own name, icon and colours. One Expo project and one Firebase project serve them all.

> [!NOTE]
> Short name with a hyphen? Android turns it into an underscore: al-noor becomes com.integr8.plus.al_noor. A short name starting with a digit gets a c in front.

- [ ] **Expo settings, once** (website): expo.dev → integr8-plus → Environment variables, production: EXPO_PUBLIC_SENTRY_DSN, EXPO_PUBLIC_AUTH_VERIFICATION_KEYS (the AUTH_VERIFICATION_KEYS line) and GOOGLE_SERVICES_JSON as a File.

- [ ] **Add the company in Firebase** (website): Project settings → Add app → Android, package com.integr8.plus.`<short name>`.

- [ ] **Replace google-services.json on Expo** (website): Download it again from Firebase (it now lists every company) and replace the GOOGLE_SERVICES_JSON file variable.

- [ ] **Switch its apps on** (website): Dashboard → the company → Website and apps → Build apps for this company → Save.

- [ ] **Start the build** (website): GitHub → Actions → Build company apps → Run workflow, branch main, company = the short name. Leave the rest empty. company = all builds every switched-on company.

- [ ] **First build only: the signing key** (website): If the phone job stops about an Android keystore, create it once for com.integr8.plus.`<short name>` in expo.dev → Credentials, then run the build again.

- [ ] **Push notifications for its app** (website): expo.dev → Credentials → Android → the company's app → FCM V1 service account key: upload the Firebase key the first time, choose the same key after.

- [ ] **Hand the apps over** (website): The company's release on GitHub holds the installers and the Android .apk. Send them /download?company=`<short name>`.

## Stage 10 — Go live

_2 hours._ Production mode, backups that leave the machine, and alerts when something stops.

- [ ] **Switch to production** (machine): Set APP_ENV=production in deploy/.env, then restart. The log must not say "Refusing to start in production".

```bash
cd /opt/integr8
sh deploy/vps/check-env.sh
docker compose -f deploy/compose.yml --env-file deploy/.env up -d
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] **Nightly backup** (machine): sudo crontab -e and add this line. It keeps fourteen dumps in /home/integr8-backup.

```bash
0 3 * * * /opt/integr8/deploy/vps/backup-postgres.sh >> /var/log/integr8-backup.log 2>&1
```

- [ ] **Off-machine copies: a bucket of their own** (website): Cloudflare → R2 Object Storage → Create bucket, named integr8-backups. Backups on the machine are lost with the machine; this bucket keeps the newest 30, encrypted.

- [ ] **A token for that bucket only** (website): R2 → Manage API tokens → Create API token: name integr8-backups, permission Object Read & Write, applied to the integr8-backups bucket only, no expiry. Copy the Access Key ID and Secret Access Key (shown once). Do not reuse the media token: it can delete every company's files.

- [ ] **Make the encryption passphrase** (machine): Save it in the password manager beside HR_DATA_KEY before going on. Without it nobody can ever read the copies.

```bash
openssl rand -base64 32
```

- [ ] **Install rclone** (machine): The program that copies each backup to R2.

```bash
sudo apt-get install -y rclone
```

- [ ] **Connect rclone to the bucket** (machine): Run as root, because the nightly backup runs as root. Replace ACCESS-KEY-ID, SECRET-ACCESS-KEY, ACCOUNT-ID (Cloudflare's Account ID from Stage 1) and PASSPHRASE. The last line must give no error and list nothing yet.

```bash
sudo rclone config create r2 s3 provider=Cloudflare \
  access_key_id=ACCESS-KEY-ID secret_access_key=SECRET-ACCESS-KEY \
  endpoint=https://ACCOUNT-ID.r2.cloudflarestorage.com no_check_bucket=true
sudo rclone config create r2crypt crypt remote=r2:integr8-backups \
  filename_encryption=off password=PASSPHRASE --obscure
sudo rclone lsf r2crypt:
```

- [ ] **Tell the backup where to copy** (machine): Add this line to deploy/.env (nano deploy/.env). BACKUP_REMOTE_KEEP changes how many copies R2 keeps; 30 by default.

```bash
BACKUP_REMOTE=r2crypt:
```

- [ ] **Run a backup and check the copy** (machine): The last lines say "copied integr8-….sql.gz to r2crypt:" and "keeping 30 on r2crypt: (removed 0)". In Cloudflare the bucket now shows integr8-….sql.gz.bin. A line starting ERROR: names what failed; the backup on the machine is still kept.

```bash
sudo /opt/integr8/deploy/vps/backup-postgres.sh
sudo rclone lsf r2crypt:
```

- [ ] **Rehearse a restore** (machine): Restores the newest copy from R2 into a throwaway container and never touches the live database. Monthly.

```bash
sudo /opt/integr8/deploy/vps/restore-drill.sh --remote
```

- [ ] **Know how to get a copy back** (machine): On any machine: install rclone and connect it with the same two commands and the same passphrase, then list the copies and fetch one. It is then an ordinary backup file.

```bash
sudo rclone lsf r2crypt:
sudo mkdir -p /home/integr8-backup
sudo rclone copy r2crypt:integr8-YYYYMMDD-HHMM.sql.gz /home/integr8-backup/
```

- [ ] **Heartbeats** (machine): Two heartbeat monitors (healthchecks.io or Better Stack): BACKUP_PING_URL and HEALTH_PING_URL in deploy/.env, and this cron line.

```bash
*/5 * * * * /opt/integr8/deploy/vps/heartbeat.sh >> /var/log/integr8-heartbeat.log 2>&1
```

- [ ] **Keep the machine** (website): Upgrade the Oracle account to Pay As You Go so an idle machine is never reclaimed. Add a Bronze boot-volume backup policy.

- [ ] **Reboot test** (machine): After sudo reboot the whole stack is back by itself within two minutes.

## Stage 11 — Update to a new version

_30 min each release._ Clear the ticks of this stage each time you update.

- [ ] **Make the release** (website): Bump the version, merge into main through dev and staging, and wait for Version release to finish green. Read the release notes.

- [ ] **Back up first** (machine): The newest file has today's date. Keep at least 5 GB free.

```bash
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lh /home/integr8-backup | tail -3
df -h /
```

- [ ] **Get the new code and new settings** (machine): The comm line prints settings the new version needs that your file lacks; add each one. Put the real version number in the sed line.

```bash
cd /opt/integr8
git pull
comm -13 <(grep -oE '^[A-Z_0-9]+=' deploy/.env | sort -u) <(grep -oE '^[A-Z_0-9]+=' deploy/.env.example | sort -u)
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.4.0/; s/^API_RELEASE=.*/API_RELEASE=1.4.0/' deploy/.env
```

- [ ] **Restart on the new version** (machine): Builds the images, runs new migrations, then starts everything again.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
```

- [ ] **Check it worked** (machine): Every service Up, the API ready, the dashboard's Health page quiet, Sentry quiet for half an hour.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env ps
curl -s http://127.0.0.1:3000/health/ready; echo
```

- [ ] **The apps** (website): Desktop apps offer the update themselves. Phones get it over the air. Company apps were rebuilt by the release.

- [ ] **Clean up the next day** (machine): Never prune volumes: the database lives in one.

```bash
docker image prune -f
docker builder prune -f
```

- [ ] **If something goes wrong** (machine): Go back to the previous release's code; its database stays as it is. Put the previous version in place of PREVIOUS-VERSION (git tag lists them).

```bash
git fetch --tags
git tag --sort=-v:refname | head -5
git checkout vPREVIOUS-VERSION
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

## Stage 12 — Start fresh on the machine

_30 min._ Deletes every Integr8 container, the database and the images, then starts again from an empty database. Every company, staff account and sign-in on this machine is lost. Other projects on the machine (MyRooms) are not touched.

- [ ] **Back up first** (machine): Even when nothing is meant to be kept: it is the only way back. The newest file has today's date.

```bash
sudo /opt/integr8/deploy/vps/backup-postgres.sh
ls -lh /home/integr8-backup | tail -3
```

- [ ] **Copy the backup and the settings to the laptop** (laptop): Run on the laptop. deploy/.env is not deleted, but keep a copy anyway. Put the real file name from the previous step.

```powershell
scp LOGIN-USER@SERVER-IP:/home/integr8-backup/integr8-YYYYMMDD-HHMM.sql.gz .
scp LOGIN-USER@SERVER-IP:/opt/integr8/deploy/.env ./integr8-env-backup
```

- [ ] **See what is running** (machine): Integr8's containers are named integr8-…. Anything else (MyRooms) stays as it is.

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}'
```

- [ ] **Delete Integr8's containers, database and images** (machine): down -v deletes the database volume; --rmi all deletes the images. Images another project still uses are refused and stay.

```bash
cd /opt/integr8
docker compose -f deploy/compose.yml --env-file deploy/.env down -v --rmi all --remove-orphans
docker builder prune -af
```

- [ ] **Check nothing is left** (machine): All three lists are empty.

```bash
docker ps -a --filter name=integr8 -q
docker volume ls --filter name=integr8 -q
docker image ls 'integr8-*' -q
```

- [ ] **Only if Integr8 is alone on the machine** (machine): Deletes every container, image and volume of every project. Skip it when MyRooms or anything else runs here.

```bash
docker stop $(docker ps -q) 2>/dev/null
docker system prune -a --volumes -f
```

- [ ] **Optional: empty the file buckets** (website): Old companies' files stay in R2 after the database is gone. Cloudflare → R2 → each integr8 bucket → delete the objects (not the backups bucket).

- [ ] **Get the newest code** (machine): deploy/.env is ignored by Git and stays. Check APP_VERSION and API_RELEASE in it match the release.

```bash
cd /opt/integr8
git checkout main
git pull
grep -E '^(APP_VERSION|API_RELEASE)=' deploy/.env
```

- [ ] **Start again** (machine): Builds the images and creates an empty database. Then do the "Start the stack" checks and "You and your staff" again: your staff account is gone too.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f bootstrap migrate auth api
```

---

Integr8 Media · Integr8 Plus 1.4.0
