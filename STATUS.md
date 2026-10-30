# Implementation Status

## COMPLETE_LOCAL

- Pinned Node and OpenClaw package contract.
- Hardened production config template with fail-closed model, Telegram, Gateway, tool and cron policies.
- Tool-only plugin with offline Google OAuth refresh, merged primary/managed free-busy reads, primary agenda title/description reads, managed-only writes, idempotent protected academic persistence, bounded redacted financial imports/reconciliation, SQLite sales, deterministic routines, tasks, reminders, academic facts, study handoffs/reports, and material metadata.
- Natural-language-only Telegram UX uses narrow tools without registering or advertising legacy slash commands.
- Model-independent reminder worker uses atomic claim-before-send and quarantines failed or interrupted deliveries. It also provides one-shot normal-mode urgent deadline alerts with permanent due-instance dedupe, a rolling 24-hour cap, safe Telegram HTML and owner-bound replay-protected actions. Verified legacy reminders without reliable timestamps are seeded paused, while task #18 preserves its date-only deadline.
- Desktop OAuth PKCE loopback bootstrap requests only Calendar free-busy, event-read-only, and app-created scopes, creates `Jarvis Plan`, and produces a restricted git-ignored Railway variable artifact.
- Explicit Railway Calendar enable/disable policy removes stale credentials when disabled and verifies primary/managed free-busy plus primary-detail and managed agenda reads. Agenda ranges and pagination are bounded and minimize event fields; only primary responses include descriptions. One-time gzip/base64 ICS import is bounded, protected, UID-idempotent, and deleted from the container after consumption.
- Occurrence-aware financial identity preserves legitimate duplicates while explicit own-account references prevent false internal-transfer matching.
- Consent-aware couple accounting stores integer COP shared expenses, exact allocations and settlements with append-only provenance. Alex is active, Sam remains pending, and the plugin exposes no consent-grant or payment capability.
- Evidence-based coaching persists study, gym, meal-prep and deep-work check-ins, weekly streaks, bounded reward eligibility, coach enablement, deduplication and cooldown state.
- Audited, restart-safe assistant mode defaults to friendly normal behavior and enters directive work behavior only after explicit natural-language intent. Study handoffs never claim unavailable legacy PDFs exist.
- Synthetic unit/integration tests cover calendar ownership, OAuth degradation, financial redaction/deduplication/ambiguity, path boundaries, sales persistence, protected blocks, ICS filtering and config safety.
- Spanish Jarvis workspace behavior, reviewed schedule and operating seed data.
- Idempotent-oriented Ubuntu bootstrap, provisioned Podman sandbox, production plugin packaging, WAL-safe encrypted backup, exact-environment preflight and smoke-test scripts.
- Security policy, threat model, ADR and operator runbooks.
- Railway production image, fail-closed persistent-volume entrypoint, config-as-code, isolated migration namespace and rollback runbook.
- Startup removes the 13 retired fixed coaching declarations by exact key, disables recurring heartbeats, refreshes only allowlisted workspace policy files, and preserves durable memory and personal notes.
- The budget-first `openai/gpt-5.6-luna` route is pinned with low reasoning and no fallback. Existing owner Telegram session overrides are migrated only through supported Gateway calls and readiness fails if a stale pin remains.

## PRIMARY_PRODUCTION_TARGET

- Existing Railway project `universidad-os-jarvis`, environment `production`, service `jarvis-telegram`.
- Existing 5 GB volume remains mounted at `/data`.
- Telegram long polling requires no public domain.
- DigitalOcean and Tailscale are unnecessary for the Railway path.
- The live successful deployment ID must be captured programmatically immediately before any explicit Railway deployment; no rollback deployment ID is committed in the repository.
- OpenClaw writes only below `/data/jarvis-v1`, preserving every existing volume path for rollback.

## BLOCKED_EXTERNAL

- Deploy the locally verified assistant-first changes to Railway, then confirm the 13 exact retired declaration keys remain absent after two worker restarts.
- `RAILWAY_RUN_UID=0` must be added to permit bounded ownership initialization of Railway's root-mounted volume; OpenClaw then runs as uid 1000.
- Railway volume download is unavailable until an SSH key is registered. This does not block the first namespaced deploy; it blocks later in-place migrations.
- BotFather token, numeric operator ID and OpenAI key already exist as Railway secrets; their values remain uninspected.
- The external OpenAI project must retain its intended spending limit.
- Operator must run the local Desktop OAuth helper, install its artifact through Railway stdin, and explicitly enable Calendar before deploying this local change.
- Operator must perform the one-time private `horarios-2026-2.ics` Railway import after Calendar is ready; no personal schedule file is committed.
- A downloadable volume backup and second protected copy after Railway SSH-key setup.
- Actual Nequi PDFs for real-layout validation.
- Sam must personally provide scoped consent before any Banco de Occidente import; no Jarvis tool can create that consent.
- Telegram voice notes remain an optional future feature. Voice calls are unsupported by the Bot API, and no paid TTS dependency is included.

No new external resource, account, credential, calendar or payment was created by this repository build. The already-paid Railway service is reused.


- Google Tasks canary worker: implemented but disabled by default; no Railway deployment or provider credential validation has been performed.
