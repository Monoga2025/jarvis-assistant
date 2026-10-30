# Security Policy

## Supported version

Only the exact dependency set in `package-lock.json`, led by OpenClaw 2026.9.1, is supported.

## Reporting

Stop the service, preserve logs without secrets, rotate affected credentials, and report privately to the operator. Do not open a public issue containing tokens, calendar identifiers, transaction descriptions or Telegram IDs.

## Secret handling

Secrets live only in `/etc/jarvis-v1.env` with mode `0600`. Scripts never print them. PDFs and ICS files remain in `/var/lib/openclaw/imports`, are excluded from backups, and must be removed after reconciliation. PDF passwords are never accepted or stored.

## Incident containment

```bash
sudo systemctl stop openclaw
sudo tailscale serve reset
sudo chmod 000 /etc/jarvis-v1.env
```

Then rotate the Telegram token, OpenAI key, Google token and Gateway token before restart.