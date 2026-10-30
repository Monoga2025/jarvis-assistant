# Jarvis Google Drive Slice 1 — Task Checklist

Planning-only artifact. All implementation and operational tasks remain unchecked until explicitly approved.

## Confirmed preparation evidence
- [x] Remote Google chat connector is authenticated; it is not Jarvis runtime OAuth.
- [x] Jarvis Railway Calendar OAuth is separate and production status is `SUCCESS`.
- [x] Populated Jarvis Plan contains 232 UNAB 2026-2 events and is canonical.
- [x] Empty calendar duplicate remains untouched.
- [x] Calendar OAuth and schedule import must not be rerun without new evidence.
- [x] Google Drive is not integrated into Jarvis.
- [x] Slice 1 is approved: `Materiales`, metadata and optional web links only, one-way Drive → Jarvis.
- [x] Downloads, content ingestion, Drive writes, Calendar, Tasks, TEMA, Supabase, Obsidian, and UNAB changes are out of scope.
- [x] Jarvis is not currently a Git repository.
- [x] Strict RED → GREEN → REFACTOR is required.
- [x] `npm run verify` is the repository validation command.
- [x] RDD remains opt-in/off.

## Initial prerequisite — repository/versioning identity
- [ ] **Task 1 (XS):** Establish a Git baseline OR a reproducible local snapshot/manifest SHA-256 fallback.
- [ ] Record the exact candidate identity and require every verification report to name it.
- [ ] Stop if neither identity is reproducible.

## Work Unit A — Contract + RED tests
- [ ] **Task 2 (S):** Define contracts, composite identity, optional fields, state semantics, page bounds, and safe errors.
- [ ] **Task 3 (M):** Write failing RED tests under root `test/*.test.ts` only.

### Checkpoint A
- [ ] Tests cover exact scope separation, folder parent validation, pagination, page limits, `incompleteSearch`, optional size/link, provider checksum fallback, state transitions, idempotency, no-op, timeout, and unknown outcomes.
- [ ] No `src/*.test.ts` files are proposed.
- [ ] No production implementation has started.

## Work Unit B — OAuth/config + files.list client
- [ ] **Task 4 (M):** Implement Drive OAuth/config separate from Calendar, Tasks, and Remote Google chat, with exact restricted scope validation and redacted logs.
- [ ] **Task 5 (M):** Implement bounded read-only `files.list` client with explicit fields, allowlisted folder query, `trashed=false`, parent revalidation, optional `size`/`webViewLink`, and no `webContentLink`.

## Work Unit C — SQLite + sync/list tools
- [ ] **Task 6 (M):** Implement atomic idempotent SQLite persistence with `active`, `stale_or_out_of_scope`, and `unknown` semantics.
- [ ] **Task 7 (S):** Expose narrow metadata-only Jarvis sync/list tools.

### Checkpoint C
- [ ] Complete validated listing can mark absent/out-of-folder rows stale without deleting them.
- [ ] Incomplete/timeout/unknown preserves the last-good index.
- [ ] Repeated identical listing is `unchanged`.
- [ ] No downloads, Drive writes, content ingestion, or cross-domain changes exist.
- [ ] Writer completed RED → GREEN → REFACTOR.

## Work Unit D — Packaging/docs + focused/full verification
- [ ] **Task 8 (S):** Update packaging, configuration audit, and operator documentation.
- [ ] **Task 9 (M):** Fresh verifier runs focused tests and `npm run verify` against the exact candidate identity.

### Checkpoint D
- [ ] Focused tests pass.
- [ ] `npm run verify` passes.
- [ ] Fresh verifier confirms no Calendar, Tasks, TEMA, Supabase, Obsidian, download, Drive-write, or UNAB changes.
- [ ] Work remains in reviewable units below 400 changed lines.
- [ ] RDD remains disabled.

## Work Unit E — Explicit human authorization + Railway deploy/canary
- [ ] **Task 10 (XS):** Obtain explicit human authorization after local verification and before any Railway mutation/deploy/canary.
- [ ] **Hard stop:** without Task 10 authorization, work ends after Task 9.
- [ ] **Task 11 (M):** Install protected Jarvis Railway Drive variables and deploy with previous-deployment rollback evidence.
- [ ] **Task 12 (S):** Run the bounded production read-only canary against `Materiales`.

## Ownership and protections
- [ ] One writer owns shared implementation files.
- [ ] Fresh-context verifier owns verification and production evidence.
- [ ] No parallel writers on shared files.
- [ ] Drive OAuth/token/config remains separate from Calendar, Tasks, and Remote Google chat credentials.
- [ ] No task touches `04_UNAB_INGENIERIA/UNAB_OS_Plataforma`.
- [ ] No task reruns Calendar OAuth or re-imports the canonical schedule without new evidence.
- [ ] No task enables RDD automatically.

## Final acceptance
- [ ] Identity is `driveAccountId + sourceFolderId + driveFileId`; folder name is display-only.
- [ ] Required metadata is validated; `size` and `webViewLink` are optional.
- [ ] `webContentLink` is never requested or persisted.
- [ ] Page count is bounded and `incompleteSearch` cannot be treated as complete.
- [ ] Only complete validated listings mark `stale_or_out_of_scope`.
- [ ] No physical deletion occurs in slice 1.
- [ ] Provider checksum is optional; fallback is canonical metadata hash, never a downloaded content fingerprint.
- [ ] No-op and rollback behavior is proven and documented.
- [ ] Obsidian projection remains future work only.