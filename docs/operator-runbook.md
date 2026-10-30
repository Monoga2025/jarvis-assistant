# Operator Runbook

> This is the alternative standalone Ubuntu/VPS path. Railway is the primary production target; use `docs/railway-runbook.md`. DigitalOcean and Tailscale are not required for Railway.

## 1. External prerequisites

1. Explicitly approve and create the DigitalOcean Droplet: Ubuntu 24.04, New York, 1 GB RAM.
2. Download an official Node 24 Linux tarball and record its published SHA-256; do not pipe remote scripts into a shell.
3. Authenticate Tailscale and confirm the device is private.
4. Create a BotFather token and obtain the operator's numeric Telegram user ID.
5. Create a dedicated OpenAI project/key and enforce a USD 12 monthly hard limit in the provider account.
6. Create `Jarvis Plan` in Google Calendar and complete OAuth consent with the minimum required scopes.
7. Choose private backup storage and an `age` recipient.

## 2. Host setup

Copy the repository and run:

```bash
sudo NODE_TARBALL_PATH=/root/node.tar.xz NODE_TARBALL_SHA256='<published sha256>' deploy/bootstrap-ubuntu.sh
sudo cp .env.example /etc/jarvis-v1.env
sudo chown root:root /etc/jarvis-v1.env
sudo chmod 0600 /etc/jarvis-v1.env
sudoedit /etc/jarvis-v1.env
sudo deploy/configure-openclaw.sh "$PWD"
sudo deploy/configure-automations.sh
sudo deploy/smoke-test.sh
```

Never paste secrets into shell history. Use `sudoedit` for the environment file.

## 3. Calendar and imports

Copy the academic ICS into `/var/lib/openclaw/imports`, invoke `academic_import_ics`, review rejected events, then create protected calendar entries through the operator workflow. Do not commit the ICS.

Place one statement PDF at a time in the import directory, invoke `finance_import_statement`, reconcile the month, record ambiguous lines, and delete the PDF after review. Partner statements require explicit partner consent.

## 4. Backups and upgrades

Run `deploy/backup.sh` from a root-owned weekly systemd timer. Test decryption quarterly on an isolated host. Before any OpenClaw update: snapshot, build, run all repository checks, validate the plugin, read upstream security notes, deploy, and run the smoke test. Never use a moving version tag.
