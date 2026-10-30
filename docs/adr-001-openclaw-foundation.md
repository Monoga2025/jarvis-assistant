# ADR-001: Hardened OpenClaw foundation

- Status: Accepted
- Date: 2026-09-05

## Context

Jarvis must operate continuously on a small VPS while protecting calendar commitments, financial documents and a single Telegram operator. Building messaging, scheduling and memory from scratch would add unnecessary operational risk.

## Decision

Use the pinned OpenClaw 2026.9.1 release without a permanent fork. Add one tool-only plugin with deterministic policy enforcement. Run as a non-root user on Ubuntu 24.04, bind the Gateway to loopback, publish only through Tailscale Serve, require token auth, deny broad runtime capabilities, and use a rootless Podman sandbox.

Google Calendar uses a split authority model: merge FreeBusy intervals from the primary and managed calendars; create/update only on the separate managed calendar; never delete or invite attendees. Banking integrations accept local PDFs only and expose no login or payment capability.

## Consequences

OpenClaw upgrades are manual and require rebuilding, plugin validation, security audit and smoke tests. External account provisioning remains an operator responsibility. OpenClaw and Codex/Engram memory remain separate.
