# Repository Rules

- Use Node >=24.15 and <25.
- Keep `openclaw` pinned exactly to 2026.9.1.
- Use strict RED -> GREEN -> REFACTOR for behavior changes.
- Keep production code and engineering documentation in English. Assistant-facing behavioral content may use professional neutral Spanish.
- Never broaden the tool surface with shell, browser, unrestricted filesystem access, external messaging, payment or automation management.
- Calendar writes must target the configured managed calendar and preserve `jarvisManaged=true` plus `jarvisBlockId`.
- Never commit real statements, calendars, credentials or database files.
- Use conventional commits without attribution trailers.
- Run `npm run verify` before delivery.