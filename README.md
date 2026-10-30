# Jarvis

A single-operator personal operating system built as a tool-only plugin for the OpenClaw runtime. Jarvis runs as a Telegram assistant that manages calendar boundaries, durable tasks and reminders, study metadata, local financial reconciliation, evidence-based coaching and a small sales pipeline, all through narrow deterministic tools instead of free-form shell or browser access.

## Why it is interesting

- **Deterministic tools behind a language model.** The model maps natural requests to a short allowlist of plugin tools. Shell, browser, general filesystem and automation-management tools are denied by configuration.
- **Fail-closed by default.** Unknown owners, malformed state and ambiguous delivery outcomes stop instead of guessing. Reminders are quarantined rather than risking duplicate sends.
- **Money stored as integers.** Financial and couple-accounting records use integer COP amounts, exact allocations and append-only provenance.
- **Least-privilege Google access.** Calendar reads are bounded and minimized. Writes target a single dedicated calendar, and rescheduling requires ownership markers.

## Features

- Natural-language Telegram conversations (no slash-command menu).
- Durable tasks and reminders with atomic claim-before-send delivery.
- Urgent deadline alerts with per-instance dedupe and a rolling 24-hour cap.
- Google Calendar free/busy merge and bounded agenda reads; one-time, UID-idempotent ICS import.
- Local financial file import (restricted directory, traversal and symlink escape rejected) and reconciliation.
- Couple accounting with consent gates (no tool can grant consent).
- Evidence-based coaching check-ins with bounded reward eligibility.
- SQLite sales pipeline and routine planning.

## Stack

- TypeScript (strict), Node.js 24, `node:test` with `tsx`.
- OpenClaw runtime (`openclaw@2026.9.1`) with a tool-only plugin.
- ESLint, TypeBox schemas, pdfjs-dist for document reading.
- Railway deployment (Dockerfile, long-polling worker, persistent volume).

## Channels

| Channel | Status | Where |
|---|---|---|
| Telegram (OpenClaw, long polling) | **Primary**, supported and tested | `plugins/jarvis-tools/`, `config/` |
| WhatsApp (Evolution API + OpenRouter) | **Experimental**, not wired into the runtime | `plugins/whatsapp-channel/` |

The WhatsApp modules come from an earlier standalone WhatsApp bot that was folded into this repository; this branch consolidates the private prototype and the legacy WhatsApp bot without importing their git history. Only the reusable, personal-data-free pieces were ported; see `plugins/whatsapp-channel/README.md`. Run its offline tests with `npm run test:whatsapp`.

## Structure

- `plugins/jarvis-tools/`: the OpenClaw plugin (tool implementations, reminder worker, Google clients).
- `plugins/whatsapp-channel/`: experimental WhatsApp channel modules (offline-tested, not wired in).
- `config/`: version-pinned production config templates.
- `data/`: sample schedule, metrics, budget taxonomy, offer and pilot scorecard (all values here are samples).
- `deploy/`: Railway entrypoint, backup gate and optional VPS scripts.
- `docs/`: architecture decision record, threat model and operator runbooks.
- `scripts/`: config audit, package check, Google OAuth bootstrap helper and SQLite snapshot tool.
- `test/`: synthetic unit and integration tests.

## How to run

Requires Node `>=24.15 <25`.

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run plugin:validate
npm run audit:config
```

To bootstrap Google Calendar locally, create a Google **Desktop app** OAuth client and run `npm run calendar:oauth -- --client <desktop-client.json>`. Secrets are read from environment variables or local files that are git-ignored. Copy `.env.example` to a private file and fill it; never commit real values.

## Honest status

- Local implementation and tests are complete for the core tool set, per `STATUS.md`.
- Production deployment depends on a Railway service and Google credentials that are not included here.
- Test fixtures are synthetic. They do not prove compatibility with real bank statement layouts or real ICS exports.
- Voice calls are not supported (the Telegram Bot API only allows voice notes).
- Personal data (owner name, schedules, budgets, couple accounting, real statements) was removed or replaced with samples for publication.
