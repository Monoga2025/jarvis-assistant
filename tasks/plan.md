# Implementation Plan: Jarvis Google Drive Metadata Integration

## Outcome and scope
Deliver a one-way, metadata-only Google Drive slice for the allowlisted `Materiales` folder. Jarvis will read validated metadata and optional web links, persist an idempotent local SQLite index, and expose narrow sync/list tools. Slice 1 does not download files, ingest content, write to Drive, modify Calendar, TEMA, Supabase, or Obsidian, and must not touch `C:\Users\Monoga\Desktop\Monoga OS\04_UNAB_INGENIERIA\UNAB_OS_Plataforma`.

## Confirmed baseline
- Remote Google is authenticated for this chat, but it is not Jarvis runtime authentication.
- Jarvis Railway has separate Calendar OAuth variables and production status `SUCCESS`.
- The populated Jarvis Plan calendar contains 232 UNAB 2026-2 events and is canonical; the empty duplicate remains untouched.
- Do not re-run Calendar OAuth or re-import the schedule unless later evidence proves it missing.
- Google Drive is not currently integrated into Jarvis.
- RDD is opt-in and must not be enabled automatically.
- Jarvis is not currently a Git repository.
- Repository validation command: `npm run verify`.

## Architecture decisions
1. **Separate credential domains.** Remote Google chat auth, Jarvis Drive OAuth, Jarvis Calendar OAuth, and any Google Tasks credentials are distinct. Drive uses its own protected configuration and token lifecycle; no chat token or Calendar/Tasks token is reused.
2. **Restricted metadata scope only.** Use exactly `https://www.googleapis.com/auth/drive.metadata.readonly`. Validate the exact requested/granted scope and redact tokens, authorization headers, and private URLs from logs.
3. **Stable identity.** The persistence identity is `(driveAccountId, sourceFolderId, driveFileId)`. The folder name `Materiales` is display-only and never an identity key.
4. **Read-only Drive client.** Use `files.list` with explicit fields, `q`, pagination, and a bounded page limit. Request `id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed`; `size` and `webViewLink` are optional. Never request or persist `webContentLink`.
5. **Defense in depth.** Query with the allowlisted folder and `trashed = false`, then validate every returned file has `sourceFolderId` in `parents`. Unexpected parents, unsafe values, malformed responses, and disallowed MIME states fail closed.
6. **State semantics.** Each indexed row has exactly one operational state: `active`, `stale_or_out_of_scope`, or `unknown`.
   - `active`: present in a complete, validated listing and inside the allowlisted folder.
   - `stale_or_out_of_scope`: previously indexed but absent from a complete validated listing, or no longer in the allowlisted folder. It is retained and never physically deleted in slice 1.
   - `unknown`: listing/persistence could not establish truth because of timeout, incomplete page, `incompleteSearch`, provider error, or ambiguous outcome. Unknown runs preserve the last-good row states.
   Only a complete validated listing may transition absent rows to `stale_or_out_of_scope`.
7. **Provider checksum, not downloaded fingerprint.** Persist an optional provider checksum only when Google supplies one. Never compute a checksum by downloading content. If no provider checksum exists, derive a canonical metadata hash from the normalized metadata fields; this is not a content hash and must be named accordingly.
8. **Idempotent local projection.** Atomic upsert on the composite identity; repeat listings produce a no-op/`unchanged` result. Failed or unknown syncs leave the previous committed index intact.
9. **Future work.** Obsidian projection, content extraction, downloads, Drive writes, and cross-domain joins are future work after slice 1; they are not implementation tasks here.

## Dependency graph
```text
Initial repository/versioning prerequisite
        ↓
A. Contract + RED tests
        ↓
B. OAuth/config + files.list client
        ↓
C. SQLite + sync/list tools
        ↓
D. Packaging/docs + focused/full verification
        ↓
E. Explicit human authorization + protected Railway deploy/canary
```

## Official Google evidence
- [API-specific authorization](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list): `q`, pagination, and explicit fields
- [`files` resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Fields parameter](https://developers.google.com/workspace/drive/api/guides/fields-parameter)

Required request fields: `nextPageToken, incompleteSearch, files(id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed)`. The client must enforce a configured maximum page count and treat `incompleteSearch=true`, missing continuation within the bound, provider errors, or timeout as incomplete/unknown rather than complete.

## Initial repository/versioning prerequisite
This is a prerequisite, not a large implementation gate. Task 1 must establish either:
- a Git baseline (repository identity plus commit/hash), **or**
- a documented reproducible local snapshot fallback: deterministic file manifest, SHA-256 manifest hash, timestamp, excluded paths, and exact reproduction command.

Every later verification record must name the identity actually established. If neither identity is reproducible, implementation stops before production changes.

## Five implementation work units

### Work Unit A — Contract + RED tests

#### Task 1 — Establish candidate identity and protected baseline (XS)
**Description:** Establish a Git baseline or reproducible local snapshot/hash for Jarvis, record the candidate identity, and confirm the UNAB repository is excluded.

**Acceptance criteria:**
- [ ] Git baseline or reproducible manifest/hash fallback is recorded with its exact identity and reproduction command.
- [ ] Verification artifacts name that identity; no baseline claim relies on an untracked timestamp alone.
- [ ] No files under the UNAB repository are changed and no secrets are staged.

**Verification:** Read-only status/diff plus verification of the selected commit/hash or reproducible manifest command.

**Dependencies:** None

**Likely files:** `tasks/plan.md`, `tasks/todo.md`, or approved repository/versioning metadata only.

**Estimated scope:** XS

#### Task 2 — Define Drive contracts and state model (S)
**Description:** Define input/output types and boundary validation for Drive account/folder/file identity, optional metadata, canonical metadata hash, optional provider checksum, page limits, `incompleteSearch`, sync results, and the three row states.

**Acceptance criteria:**
- [ ] Identity is `driveAccountId + sourceFolderId + driveFileId`; folder name is display-only.
- [ ] `webViewLink` is optional; `webContentLink` is not accepted or persisted.
- [ ] State transitions enforce complete-listing-only stale marking and preserve last-good state for incomplete/unknown runs.

**Verification:** Contract review and boundary test cases defined before implementation.

**Dependencies:** Task 1

**Likely files:** `plugins/jarvis-tools/src/drive-contract.ts`, `test/drive-contract.test.ts`.

**Estimated scope:** S

#### Task 3 — Write failing RED tests (M)
**Description:** Add root-level tests following the existing Jarvis convention for scope separation, exact scope validation, response validation, folder allowlist, page bounds, `incompleteSearch`, optional fields, shortcuts, duplicate/moved files, provider checksum fallback, state transitions, idempotency, no-op, timeout, and unknown outcomes.

**Acceptance criteria:**
- [ ] All tests are under the root `test/*.test.ts` convention.
- [ ] Tests use synthetic responses and credentials only; no remote calls, downloads, or mutations.
- [ ] Tests fail before the implementation exists.

**Verification:** Run the focused root test command during implementation and capture RED evidence without enabling RDD.

**Dependencies:** Task 2

**Likely files:** `test/drive-auth.test.ts`, `test/drive-client.test.ts`, `test/drive-store.test.ts`, `test/drive-tools.test.ts`.

**Estimated scope:** M

### Work Unit B — OAuth/config + `files.list` client

#### Task 4 — Implement separate Drive OAuth/config (M)
**Description:** Add Jarvis-owned Drive OAuth/config handling, explicitly separate from Calendar, Tasks, and Remote Google chat authentication, with exact restricted-scope checks and redacted diagnostics.

**Acceptance criteria:**
- [ ] Missing, extra, revoked, or ambiguous scopes fail closed; only `drive.metadata.readonly` is accepted for this slice.
- [ ] Drive variables/token files are distinct from Calendar/Tasks variables and never printed or committed.
- [ ] Logs redact secrets, authorization headers, refresh tokens, and private link values.

**Verification:** Root OAuth/config tests plus configuration audit with synthetic values only.

**Dependencies:** Task 3

**Likely files:** `plugins/jarvis-tools/src/drive-auth.ts`, `scripts/google-drive-oauth.ts`, `config/*`, `test/drive-auth.test.ts`.

**Estimated scope:** M

#### Task 5 — Implement bounded metadata client (M)
**Description:** Implement a read-only `files.list` client with explicit fields, allowlisted `sourceFolderId`, `trashed=false`, bounded pagination, `incompleteSearch` handling, parent validation, and optional `size`/`webViewLink` normalization.

**Acceptance criteria:**
- [ ] Query constrains the configured folder and `trashed = false`; every returned file is revalidated against `parents`.
- [ ] Page count/continuation is bounded; `incompleteSearch`, timeout, provider error, or ambiguous continuation yields `unknown`/incomplete and never a complete listing.
- [ ] No `webContentLink`, download, Drive write, Calendar/Tasks call, TEMA, Supabase, or Obsidian path exists.

**Verification:** Root mocked HTTP tests cover pagination, page limit, incomplete search, moved files, duplicates, shortcuts, Workspace files without size, malformed links, and timeout.

**Dependencies:** Tasks 3–4

**Likely files:** `plugins/jarvis-tools/src/drive-client.ts`, `test/drive-client.test.ts`.

**Estimated scope:** M

### Work Unit C — SQLite + sync/list tools

#### Task 6 — Implement idempotent SQLite index (M)
**Description:** Add the local persistence schema/repository keyed by `driveAccountId`, `sourceFolderId`, and `driveFileId`, storing normalized metadata, optional provider checksum, canonical metadata hash, timestamps, and state.

**Acceptance criteria:**
- [ ] Atomic upsert prevents duplicates and treats identical input as `unchanged`.
- [ ] Complete validated listings mark absent/out-of-folder rows `stale_or_out_of_scope`; no row is physically deleted.
- [ ] Incomplete/timeout/unknown runs preserve the last-good index and states.
- [ ] No OAuth secrets, file bytes, content, or `webContentLink` are stored.

**Verification:** Root store tests cover replay, changed metadata, absent rows, moved files, transaction interruption, no-op, and unknown preservation.

**Dependencies:** Tasks 2 and 5

**Likely files:** `plugins/jarvis-tools/src/drive-store.ts`, `plugins/jarvis-tools/src/drive-sync.ts`, `test/drive-store.test.ts`, `test/drive-sync.test.ts`.

**Estimated scope:** M

#### Task 7 — Expose narrow Jarvis sync/list tools (S)
**Description:** Register deterministic Drive metadata sync/list tools with bounded inputs and stable responses; expose only owner-scoped metadata and optional validated `webViewLink`.

**Acceptance criteria:**
- [ ] Tools cannot download, ingest content, write Drive, access unrestricted files, or modify existing domains.
- [ ] Sync/list responses expose state, pagination, counts, no-op status, and bounded errors without secrets or `webContentLink`.
- [ ] Existing Calendar, Tasks, TEMA-related study, finance, and ICS tool contracts remain unchanged.

**Verification:** Root plugin contract and allowlist tests confirm exact tool surface and response shapes.

**Dependencies:** Task 6

**Likely files:** `plugins/jarvis-tools/src/index.ts`, `plugins/jarvis-tools/src/drive-tools.ts`, `test/drive-tools.test.ts`.

**Estimated scope:** S

### Work Unit D — Packaging/docs + focused/full verification

#### Task 8 — Package and document the isolated slice (S)
**Description:** Update package/config audits and operator documentation for separate Drive OAuth, restricted scope, folder identity, page bounds, state semantics, redaction, no-op/rollback, and protected deployment rules.

**Acceptance criteria:**
- [ ] Package checks exclude credentials, tokens, SQLite artifacts, and real Drive data.
- [ ] Documentation says Calendar OAuth/schedule import are not rerun and the UNAB repository is untouched.
- [ ] RDD remains opt-in/off and no Drive secret appears in logs or examples.

**Verification:** `npm run audit:config`, package audit, and documentation readback with synthetic config.

**Dependencies:** Task 7

**Likely files:** `README.md`, `docs/drive-runbook.md`, `scripts/audit-config.ts`, `scripts/check-production-package.ts`, config templates.

**Estimated scope:** S

#### Task 9 — Fresh focused and full verification (M)
**Description:** A fresh verifier inspects the exact candidate identity from Task 1, runs focused Drive tests, then runs `npm run verify` and checks for prohibited cross-domain changes.

**Acceptance criteria:**
- [ ] Focused tests pass and `npm run verify` passes.
- [ ] The report names the Git commit/hash or snapshot manifest/hash from Task 1.
- [ ] Verifier confirms no Calendar, Tasks, TEMA, Supabase, Obsidian, download, Drive-write, or UNAB changes.
- [ ] RED → GREEN → REFACTOR evidence is present.

**Verification:** Fresh-context verifier owns the report; implementation writer does not self-author the final pass.

**Dependencies:** Task 8

**Likely files:** No intended source changes; verification evidence only.

**Estimated scope:** M

### Work Unit E — Explicit human authorization + Railway deploy/canary

#### Task 10 — Obtain separate human authorization for Railway mutation (XS)
**Description:** Present a hard, explicit authorization checkpoint after local verification and before any protected Railway variable installation, deployment, or production canary.

**Acceptance criteria:**
- [ ] Authorization names the exact verified candidate identity, target Jarvis Railway service, variables/actions permitted, and rollback plan.
- [ ] No authorization means work stops after Task 9; no Railway mutation, deployment, or canary occurs.
- [ ] Remote Google chat authentication is not accepted as authorization for Jarvis Railway mutation.

**Verification:** Human authorization is recorded as an explicit approval artifact before any mutation command is eligible.

**Dependencies:** Task 9

**Likely files:** Operator/deployment record only; no source changes.

**Estimated scope:** XS

#### Task 11 — Install protected variables and deploy (M)
**Description:** With Task 10 authorization, install Jarvis-owned Drive variables through the protected Railway path, capture the previous deployment identity, deploy, and retain rollback evidence.

**Acceptance criteria:**
- [ ] Variables are installed only in Jarvis Railway and remain redacted.
- [ ] Previous deployment identity and rollback action are recorded.
- [ ] Deployment does not rerun Calendar OAuth/import or touch the UNAB repository.

**Verification:** Fresh verifier checks deployment status/config health and absence of prohibited side effects.

**Dependencies:** Task 10

**Likely files:** `docs/drive-runbook.md` or protected operator records; no UNAB files.

**Estimated scope:** M

#### Task 12 — Run bounded production read-only canary (S)
**Description:** With the same authorization and deployed candidate, run a metadata-only canary against `Materiales` using Jarvis OAuth.

**Acceptance criteria:**
- [ ] Canary returns only expected metadata and optional `webViewLink`.
- [ ] Retry is `unchanged`; timeout/incomplete outcome preserves last-good state.
- [ ] No download, Drive write, Calendar/Tasks change, TEMA, Supabase, Obsidian, or UNAB mutation occurs.

**Verification:** Evidence records redacted status, counts, page completeness, latency, and rollback readiness.

**Dependencies:** Task 11

**Likely files:** No source changes; operator evidence only.

**Estimated scope:** S

## Ownership and routing
- One writer owns implementation and shared files sequentially.
- Fresh-context verifier owns focused/full verification and production evidence.
- No parallel writers on shared files, SQLite schema, `index.ts`, config, or package scripts.
- No task may mix Calendar, Tasks, TEMA, Supabase, Obsidian, or UNAB repository changes.

## Review Workload Forecast
- Use five reviewable work units A–E, each below 400 changed lines.
- Split any unit approaching 400 lines before implementation; do not include unrelated refactors.
- Unit D verification is fresh-context and must use the candidate identity established in the initial prerequisite.
- RDD remains disabled unless the user explicitly enables it.

## Risks and mitigations
| Risk | Mitigation |
|---|---|
| Restricted scope verification burden | Exact scope allowlist, redacted OAuth tests, protected operator approval, and audit evidence. |
| Duplicate or moved files | Composite identity and client-side parent validation; never merge by display name. |
| Shortcuts | Handle as explicit metadata policy; never follow or download targets. |
| Workspace files without size | Treat `size` as optional; never infer it from content. |
| Checksums are not universal | Store optional provider checksum only; otherwise use clearly named canonical metadata hash. |
| Page limit or `incompleteSearch` | Bound pages and classify incomplete/unknown; preserve last-good state. |
| Timeout/unknown outcome | No blind retry or overwrite; retain prior committed index and report unknown. |
| Private link leakage | `webViewLink` optional, owner-scoped, validated, and redacted where logged; never persist `webContentLink`. |
| Stale index | Only complete validated listings mark stale/out-of-scope; retain rows and never physically delete in slice 1. |
| No Git baseline | Require reproducible Git or manifest/hash identity before implementation and name it in verification. |
| Unauthorized Railway mutation | Hard human authorization gate after local verification; absence stops the plan. |

## Rollback and no-op
- **No-op:** identical normalized metadata returns `unchanged` and performs no row churn or downstream action.
- **Incomplete/unknown:** keep the last-good index and row states; do not mark stale.
- **Complete listing:** mark missing/out-of-folder rows `stale_or_out_of_scope`; never physically delete.
- **Deployment rollback:** restore the recorded prior Jarvis Railway deployment and disable Drive configuration/tools; do not touch Calendar or Jarvis Plan.
- **Data rollback:** restore the prior local SQLite artifact through the protected operator path; Drive remains unchanged.

## Future work only
- Obsidian projection after slice 1 stability and separate approval.
- Content downloads/extraction, Drive writes, recursive traversal, and cross-domain joins after separate contracts and authorization.