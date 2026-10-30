# WhatsApp channel (experimental)

> **Status: experimental, not wired into the runtime.** Telegram through OpenClaw is the supported primary channel. This directory holds the building blocks of an earlier WhatsApp bot (Evolution API + OpenRouter), rewritten as small, dependency-free ES modules with injectable `fetch`, clock and state store so they can be tested offline.

## Modules

- `client.js`: Evolution API client (send text, human-paced multi-part replies split on `|||`, typing presence, webhook setup, connection status, media download).
- `openrouter.js`: receipt OCR (strict JSON reply) and audio transcription through OpenRouter.
- `proactive-filter.js`: anti-spam gate for proactive messages (per-type cooldowns, identical-content suppression, capped log, crisis-mode flag). State is supplied by the caller as `{ read(), write(state) }`.

## Configuration (names only)

See `.env.example`: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `OPENROUTER_API_KEY`, `VISION_MODEL`. Real values stay in a private, git-ignored env file. Missing values fail closed; HTTP errors never echo response bodies.

## Not included

The legacy conversational brain, tool router, Slack bridge, persona prompts, runtime state and logs were intentionally left out: they contained personal data and are not part of the sanitized project.

## Tests

```bash
npm run test:whatsapp
```

Uses only `node:test` and fakes; no network access.

## Caveats

- Unofficial WhatsApp automation can violate WhatsApp terms and get numbers banned; use at your own risk.
- Outbound sends should stay human-approved or limited to contacts who messaged first, consistent with the rest of the project.
