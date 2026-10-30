# Threat Model

## Assets

Telegram identity, OpenAI and Google credentials, Gateway token, calendar commitments, transaction data, couple allocations and consent state, coaching evidence, sales records and personal routines.

## Trust boundaries

One VPS and one numeric Telegram operator form one trust boundary. OpenClaw plugins are trusted code. Model output and imported documents are untrusted. Google, Telegram, OpenAI, Tailscale, DigitalOcean and backup storage are external services.

## Principal threats and controls

| Threat | Control |
|---|---|
| Unauthorized Telegram user | Numeric allowlist; groups disabled; one-owner configuration |
| Public control plane | Loopback bind; Tailscale Serve only; token auth; no Funnel |
| Prompt-injected host access | Minimal profile; shell/browser/files/runtime/automation denied; no elevated mode |
| Protected event modification | Separate calendar IDs; ownership marker and block ID checks; no delete API |
| Primary event detail disclosure or modification | `calendar.events.readonly`, configured-calendar allowlist, response field minimization, metadata-only logs, and no primary write path |
| Financial path escape | Canonical local root, extension checks, traversal and symlink rejection |
| Duplicate spending from transfers | Cross-account equal-value/two-day deduplication with explicit reporting |
| Partner data imported without consent | Silvia starts pending; statement import checks scoped consent before file access; no model tool grants consent |
| Couple ledger imbalance or replay | Integer COP, exact allocation sums, atomic idempotency hashes and append-only audit events |
| Manipulative motivation | Evidence-backed check-ins only; no points, shame, punishment or financial rewards; gaming capped at 45 minutes after a verified close |
| Secret disclosure | Environment file mode 0600; no secret logging; static audit; encrypted backups |
| Unbounded model spend | One pinned mini model, no fallback; external USD 12 project hard limit |
| Malicious dependency | Exact versions, lockfile, plugin validation and manual upgrade gate |

## Residual risks

A malicious trusted plugin has Gateway-process authority. Bank PDF layouts may change. Access tokens are bearer credentials. Root or VPS-provider compromise defeats host controls. These risks require monitoring, rotation, encrypted backups and real-statement validation.
