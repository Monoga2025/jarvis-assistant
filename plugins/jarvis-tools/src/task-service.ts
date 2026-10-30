import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalDate, canonicalInstant } from "./date-time.js";

export const GOOGLE_TASKS_CANARY_LEASE_TTL_MS = 60_000;

export type TaskStatus = "pending" | "completed";
export type TaskLifecycle = "inbox" | "ready" | "in_progress" | "blocked" | "done";
export type TaskKind = "unspecified" | "quiz" | "exam" | "homework" | "project" | "other";
export type TaskSyncState = "queued" | "in_flight" | "synced" | "unknown";
export interface TaskDeadline {
  precision: "unknown" | "day" | "range" | "time";
  date?: string;
  startDate?: string;
  endDate?: string;
  at?: string;
  originalText?: string | null;
  confidence?: "unknown" | "reported" | "inferred";
  sourceReference?: string | null;
}
interface TaskMetadata {
  sourceIdentity?: { sourceSystem: string; legacyId: string };
  kind: TaskKind;
  lifecycle: TaskLifecycle;
  deadline: TaskDeadline;
  plannedDate: string | null;
  description: string;
  completionCriteria: string;
  completionEvidence: string | null;
  evidenceState: "unknown" | "reported";
  updatedAt: string;
}
export interface JarvisTask extends TaskMetadata {
  syncState: TaskSyncState | "not_queued" | "conflict" | "detached";
  id: number; ownerId: string; revision: number;
  title: string; subject: string; dueDate: string | null; dueAt: string | null;
  status: TaskStatus; completedAt: string | null;
  sourceSystem: string; legacyId: string; sourceHash: string; importedAt: string;
}
export interface TaskCreateInput {
  id?: number; title: string; subject: string; dueDate?: string | null; dueAt?: string | null; status?: TaskStatus;
  sourceSystem: string; legacyId?: string; sourceHash?: string; importedAt?: string;
  kind?: TaskKind; deadline?: TaskDeadline; plannedDate?: string | null;
  description?: string; completionCriteria?: string;
}
export interface TaskChanges {
  title?: string; subject?: string; dueDate?: string | null; dueAt?: string | null;
  kind?: TaskKind; deadline?: TaskDeadline; plannedDate?: string | null;
  description?: string; completionCriteria?: string; completionEvidence?: string | null; lifecycle?: TaskLifecycle;
}
export interface TaskUpdateInput {
  id: number; expectedRevision: number; idempotencyKey: string; sourceSystem: string; changes: TaskChanges;
}
export interface TaskSyncIntent {
  id: string; ownerId: string; taskId: number; taskRevision: number; payloadHash: string;
  payload: Omit<JarvisTask, "syncState">; state: TaskSyncState; claimToken: string | null; externalReference: string | null;
}
export interface TaskSyncSettlement {
  id: string; claimToken: string; outcome: "synced" | "unknown"; externalReference?: string;
}
export interface GoogleTaskProjection {
  taskId: number; listId: string; marker: string; intentId: string; taskRevision: number; payloadHash: string;
  state: "prepared" | "unknown" | "conflict" | "synced"; remoteId: string | null;
  request: Record<string, unknown> | null; requestHash: string | null;
}
export interface GoogleTaskClaim { intent: TaskSyncIntent; projection: GoogleTaskProjection }
export interface GoogleTaskReceipt {
  outcome: "synced" | "unknown" | "conflict";
  requestHash: string | null;
  proof?: { kind: "insert_ack" | "complete_scan"; pages: number; matches: number };
  remote?: Record<string, unknown>;
}
export interface GoogleTaskSync {
  taskId: number; listId: string; remoteId: string; marker: string; version: number;
  state: "synced" | "in_flight" | "unknown" | "conflict" | "detached";
  localRevision: number; request: Record<string, unknown>; remote: Record<string, unknown>;
  pending: { intentId: string; claimToken: string; payloadHash: string; taskRevision: number; request: Record<string, unknown> } | null;
}
interface OutboxRow {
  id: string; owner_id: string; task_id: number; task_revision: number; payload_hash: string; payload_json: string;
  state: TaskSyncState; claim_token: string | null; external_reference: string | null;
}
interface TaskRow {
  id: number; title: string; subject: string; due_date: string | null; due_at: string | null; status: TaskStatus;
  completed_at: string | null; source_system: string; legacy_id: string; source_hash: string; imported_at: string;
  owner_id: string; revision: number; data_json: string;
}
const joinSql = "SELECT t.*,m.owner_id,m.revision,m.data_json FROM jarvis_tasks t JOIN jarvis_task_metadata m ON m.task_id=t.id";
const kinds: TaskKind[] = ["unspecified", "quiz", "exam", "homework", "project", "other"];
const lifecycles: TaskLifecycle[] = ["inbox", "ready", "in_progress", "blocked", "done"];
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function remoteInstantOrder(value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,30})Z$/.exec(value) : null;
  if (!match) throw new Error("Invalid normalized Google Tasks timestamp.");
  return `${match[1]}.${match[2]!.padEnd(30, "0")}`;
}
function text(value: string, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || Array.from(value).some((character) => character.charCodeAt(0) < 32 && !["\t", "\n", "\r"].includes(character))) throw new Error(`Invalid ${name}.`);
  const result = value.trim();
  if ((!empty && !result) || result.length > max) throw new Error(`Invalid ${name}.`);
  return result;
}
function deadline(value: TaskDeadline): TaskDeadline {
  if (!["unknown", "day", "range", "time"].includes(value.precision)) throw new Error("Invalid deadline precision.");
  if (value.confidence && !["unknown", "reported", "inferred"].includes(value.confidence)) throw new Error("Invalid deadline confidence.");
  const allowed = new Set(["precision", "confidence", "originalText", "sourceReference", ...({ unknown: [], day: ["date"], range: ["startDate", "endDate"], time: ["at"] }[value.precision])]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Deadline fields do not match its precision.");
  const result: TaskDeadline = { precision: value.precision, originalText: value.originalText == null ? null : text(value.originalText, "deadline wording", 1000, true),
    confidence: value.confidence ?? "reported", sourceReference: value.sourceReference == null ? null : text(value.sourceReference, "deadline source", 500) };
  if (value.precision === "day") result.date = canonicalDate(value.date ?? "", "deadline date");
  if (value.precision === "time") result.at = canonicalInstant(value.at ?? "", "deadline instant");
  if (value.precision === "range") {
    result.startDate = canonicalDate(value.startDate ?? "", "deadline start");
    result.endDate = canonicalDate(value.endDate ?? "", "deadline end");
    if (result.startDate > result.endDate) throw new Error("Deadline range must be ordered.");
  }
  return result;
}
function fromLegacyDate(dueDate: string | null, dueAt: string | null, confidence: "unknown" | "reported"): TaskDeadline {
  if (dueAt) return deadline({ precision: "time", at: dueAt, confidence });
  if (dueDate) return deadline({ precision: "day", date: dueDate, confidence });
  return deadline({ precision: "unknown", confidence: "unknown" });
}
function fromRow(row: TaskRow): JarvisTask {
  const metadata = JSON.parse(row.data_json) as TaskMetadata;
  return { ...metadata, syncState: "not_queued", id: row.id, ownerId: row.owner_id, revision: row.revision,
    title: row.title, subject: row.subject, dueDate: row.due_date, dueAt: row.due_at, status: row.status,
    completedAt: row.completed_at, sourceSystem: metadata.sourceIdentity?.sourceSystem ?? row.source_system,
    legacyId: metadata.sourceIdentity?.legacyId ?? row.legacy_id, sourceHash: row.source_hash, importedAt: row.imported_at };
}

/** Shared task writes use the caller's existing SQLite connection; no I/O or provider callbacks occur inside a transaction. */
export class TaskService {
  constructor(private readonly db: DatabaseSync, private readonly ownerId = "alex") {
    text(ownerId, "owner", 120);
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS jarvis_task_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jarvis_task_metadata(task_id INTEGER PRIMARY KEY REFERENCES jarvis_tasks(id),owner_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=1),data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jarvis_task_intents(owner_id TEXT NOT NULL,source_system TEXT NOT NULL,intent_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,task_id INTEGER NOT NULL REFERENCES jarvis_tasks(id),result_json TEXT NOT NULL,created_at TEXT NOT NULL,
          PRIMARY KEY(owner_id,source_system,intent_key));
        CREATE TABLE IF NOT EXISTS jarvis_task_outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,task_id INTEGER NOT NULL REFERENCES jarvis_tasks(id),
          task_revision INTEGER NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','in_flight','synced','unknown')),created_at TEXT NOT NULL,
          claimed_at TEXT,claim_token TEXT,external_reference TEXT,UNIQUE(task_id,task_revision));
        CREATE INDEX IF NOT EXISTS jarvis_task_outbox_queue ON jarvis_task_outbox(owner_id,state,task_id,task_revision);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS jarvis_google_task_lists(owner_id TEXT PRIMARY KEY,list_id TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS jarvis_google_task_list_owner ON jarvis_google_task_lists(list_id);
        CREATE TABLE IF NOT EXISTS jarvis_google_task_projections(task_id INTEGER PRIMARY KEY REFERENCES jarvis_tasks(id),
          owner_id TEXT NOT NULL,list_id TEXT NOT NULL,marker TEXT NOT NULL UNIQUE,intent_id TEXT NOT NULL UNIQUE REFERENCES jarvis_task_outbox(id),
          task_revision INTEGER NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','unknown','conflict','synced')),
          request_json TEXT,request_hash TEXT,remote_id TEXT,receipt_json TEXT,UNIQUE(owner_id,list_id,remote_id));`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS jarvis_google_task_sync(task_id INTEGER PRIMARY KEY REFERENCES jarvis_tasks(id),
        owner_id TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jarvis_google_tasks_canary_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),holder TEXT NOT NULL UNIQUE,acquired_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL);`);
      const missing = this.db.prepare("SELECT t.* FROM jarvis_tasks t LEFT JOIN jarvis_task_metadata m ON m.task_id=t.id WHERE m.task_id IS NULL").all() as unknown as TaskRow[];
      for (const row of missing) {
        let preserved: TaskDeadline;
        try { preserved = fromLegacyDate(row.due_date, row.due_at, "unknown"); }
        catch { preserved = deadline({ precision: "unknown", confidence: "unknown", originalText: JSON.stringify({ dueDate: row.due_date, dueAt: row.due_at }) }); }
        const metadata: TaskMetadata = { kind: "unspecified", lifecycle: row.status === "completed" ? "done" : "inbox",
          deadline: preserved, plannedDate: null, description: "", completionCriteria: "", completionEvidence: null,
          evidenceState: "unknown", updatedAt: row.imported_at };
        // Existing deployment is Alex's single-user store; opening as another principal cannot take ownership.
        this.db.prepare("INSERT INTO jarvis_task_metadata VALUES(?,?,1,?)").run(row.id, "alex", JSON.stringify(metadata));
      }
      this.db.prepare("INSERT OR IGNORE INTO jarvis_task_migrations VALUES(1,?)").run(new Date().toISOString());
      this.db.prepare("INSERT OR IGNORE INTO jarvis_task_migrations VALUES(2,?)").run(new Date().toISOString());
      this.db.prepare("INSERT OR IGNORE INTO jarvis_task_migrations VALUES(3,?)").run(new Date().toISOString());
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private get(id: number): JarvisTask {
    const row = this.db.prepare(`${joinSql} WHERE t.id=? AND m.owner_id=?`).get(id, this.ownerId) as unknown as TaskRow | undefined;
    if (!row) throw new Error("Task is not available to this owner.");
    return this.withSync(fromRow(row));
  }
  private withSync(task: JarvisTask): JarvisTask {
    const mapped = this.db.prepare("SELECT data_json FROM jarvis_google_task_sync WHERE task_id=? AND owner_id=?").get(task.id, this.ownerId);
    if (mapped) {
      const state = (JSON.parse(String(mapped.data_json)) as GoogleTaskSync).state;
      if (state !== "synced") return { ...task, syncState: state };
    }
    if (this.db.prepare("SELECT 1 FROM jarvis_google_task_projections WHERE task_id=? AND owner_id=? AND state='conflict'").get(task.id, this.ownerId)) {
      return { ...task, syncState: "conflict" };
    }
    const state = this.db.prepare(`SELECT state FROM jarvis_task_outbox WHERE owner_id=? AND task_id=? AND task_revision<=?
      ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'in_flight' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,task_revision DESC LIMIT 1`)
      .get(this.ownerId, task.id, task.revision)?.state;
    return { ...task, syncState: state as TaskSyncState | undefined ?? "not_queued" };
  }
  list(status: TaskStatus | "all" = "pending"): JarvisTask[] {
    if (!["pending", "completed", "all"].includes(status)) throw new Error("Invalid task status.");
    const query = `${joinSql} WHERE m.owner_id=?${status === "all" ? "" : " AND t.status=?"} ORDER BY COALESCE(t.due_at,t.due_date,'9999'),t.id`;
    return (this.db.prepare(query).all(...(status === "all" ? [this.ownerId] : [this.ownerId, status])) as unknown as TaskRow[]).map((row) => this.withSync(fromRow(row)));
  }
  private replay(source: string, key: string, payloadHash: string): JarvisTask | undefined {
    const row = this.db.prepare("SELECT payload_hash,result_json FROM jarvis_task_intents WHERE owner_id=? AND source_system=? AND intent_key=?").get(this.ownerId, source, key);
    if (!row) return;
    if (row.payload_hash !== payloadHash) throw new Error("Task idempotency key was reused with different content.");
    return this.withSync(JSON.parse(String(row.result_json)) as JarvisTask);
  }
  private record(source: string, key: string, payloadHash: string, task: JarvisTask, remoteReference?: string): JarvisTask {
    const payload = Object.fromEntries(Object.entries(task).filter(([name]) => name !== "syncState"));
    this.db.prepare("INSERT OR IGNORE INTO jarvis_task_outbox VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)")
      .run(randomUUID(), this.ownerId, task.id, task.revision, hash(payload), JSON.stringify(payload), remoteReference ? "synced" : "queued", new Date().toISOString(), remoteReference ?? null);
    const existing = this.db.prepare("SELECT payload_hash FROM jarvis_task_outbox WHERE owner_id=? AND task_id=? AND task_revision=?").get(this.ownerId, task.id, task.revision);
    if (existing?.payload_hash !== hash(payload)) throw new Error("Task outbox revision payload mismatch.");
    const result = this.withSync(task);
    this.db.prepare("INSERT INTO jarvis_task_intents VALUES(?,?,?,?,?,?,?)").run(this.ownerId, source, key, payloadHash, task.id, JSON.stringify(result), new Date().toISOString());
    return result;
  }

  listSyncIntents(): TaskSyncIntent[] {
    return (this.db.prepare("SELECT * FROM jarvis_task_outbox WHERE owner_id=? ORDER BY task_id,task_revision").all(this.ownerId) as unknown as OutboxRow[]).map((row) => this.outboxFromRow(row));
  }
  private outboxFromRow(row: OutboxRow): TaskSyncIntent {
    const payload = JSON.parse(row.payload_json) as TaskSyncIntent["payload"];
    if (hash(payload) !== row.payload_hash) throw new Error("Task outbox payload checksum mismatch.");
    return { id: row.id, ownerId: row.owner_id, taskId: row.task_id, taskRevision: row.task_revision, payloadHash: row.payload_hash,
      payload, state: row.state, claimToken: row.claim_token, externalReference: row.external_reference };
  }
  claimSyncIntents(limit = 20): TaskSyncIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox claim limit must be between 1 and 100.");
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT candidate.* FROM jarvis_task_outbox candidate WHERE candidate.owner_id=? AND candidate.state='queued'
        AND NOT EXISTS (SELECT 1 FROM jarvis_task_outbox earlier WHERE earlier.task_id=candidate.task_id
          AND earlier.task_revision<candidate.task_revision AND earlier.state<>'synced') ORDER BY candidate.created_at,candidate.id LIMIT ?`)
        .all(this.ownerId, limit) as unknown as OutboxRow[];
      return rows.map((row) => {
        this.outboxFromRow(row);
        const claimToken = randomUUID();
        this.db.prepare("UPDATE jarvis_task_outbox SET state='in_flight',claimed_at=?,claim_token=? WHERE id=? AND owner_id=? AND state='queued'")
          .run(new Date().toISOString(), claimToken, row.id, this.ownerId);
        return this.outboxFromRow({ ...row, state: "in_flight", claim_token: claimToken });
      });
    });
  }
  settleSyncIntent(input: TaskSyncSettlement): void {
    if (!["synced", "unknown"].includes(input.outcome)) throw new Error("Invalid sync outcome.");
    const externalReference = input.outcome === "synced" ? text(input.externalReference ?? "", "acknowledged external reference", 500) : null;
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM jarvis_task_outbox WHERE id=? AND owner_id=?").get(input.id, this.ownerId) as unknown as OutboxRow | undefined;
      if (!row) throw new Error("Sync intent is not available to this owner.");
      if (!row.claim_token || row.claim_token !== input.claimToken) throw new Error("Sync claim token mismatch.");
      if (row.state === input.outcome && row.external_reference === externalReference) return;
      if (row.state !== "in_flight") throw new Error("Sync claim is not active; reconcile unknown effects before proceeding.");
      this.db.prepare("UPDATE jarvis_task_outbox SET state=?,external_reference=? WHERE id=? AND owner_id=?")
        .run(input.outcome, externalReference, input.id, this.ownerId);
    });
  }
  acquireGoogleTasksCanaryLease(nowMs = Date.now()): string {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Google Tasks canary lease clock is invalid.");
    const holder = randomUUID(), now = new Date(nowMs).toISOString();
    this.transaction(() => {
      const existing = this.db.prepare("SELECT holder,heartbeat_at FROM jarvis_google_tasks_canary_lease WHERE singleton=1").get() as { holder: string; heartbeat_at: string } | undefined;
      if (existing) {
        const heartbeatMs = Date.parse(existing.heartbeat_at);
        // A malformed heartbeat is not evidence of a stopped holder, so fail closed.
        if (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs <= GOOGLE_TASKS_CANARY_LEASE_TTL_MS) throw new Error("Google Tasks canary lease is already held.");
        this.db.prepare("UPDATE jarvis_google_tasks_canary_lease SET holder=?,acquired_at=?,heartbeat_at=? WHERE singleton=1 AND holder=? AND heartbeat_at=?")
          .run(holder, now, now, existing.holder, existing.heartbeat_at);
      } else this.db.prepare("INSERT INTO jarvis_google_tasks_canary_lease VALUES(1,?,?,?)").run(holder, now, now);
    });
    this.assertGoogleTasksCanaryLease(holder);
    return holder;
  }
  assertGoogleTasksCanaryLease(holder: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(holder) || this.db.prepare("SELECT 1 FROM jarvis_google_tasks_canary_lease WHERE singleton=1 AND holder=?").get(holder) === undefined) {
      throw new Error("Google Tasks canary lease is unavailable.");
    }
  }
  renewGoogleTasksCanaryLease(holder: string, nowMs = Date.now()): void {
    this.assertGoogleTasksCanaryLease(holder);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Google Tasks canary lease clock is invalid.");
    const changes = this.db.prepare("UPDATE jarvis_google_tasks_canary_lease SET heartbeat_at=? WHERE singleton=1 AND holder=?").run(new Date(nowMs).toISOString(), holder).changes;
    if (changes !== 1) throw new Error("Google Tasks canary lease is unavailable.");
  }
  releaseGoogleTasksCanaryLease(holder: string): void {
    this.db.prepare("DELETE FROM jarvis_google_tasks_canary_lease WHERE singleton=1 AND holder=?").run(holder);
  }

  markInterruptedSyncUnknown(): number {
    // Call only after the single dispatcher is known stopped. Never requeue an uncertain remote insertion.
    return this.transaction(() => {
      const count = Number(this.db.prepare("UPDATE jarvis_task_outbox SET state='unknown' WHERE owner_id=? AND state='in_flight'").run(this.ownerId).changes);
      for (const row of this.db.prepare("SELECT data_json FROM jarvis_google_task_sync WHERE owner_id=?").all(this.ownerId)) {
        const sync = JSON.parse(String(row.data_json)) as GoogleTaskSync;
        if (sync.state === "in_flight") this.saveGoogleTaskSync(sync, { ...sync, state: "unknown" });
      }
      return count;
    });
  }

  getGoogleTaskProjection(taskId: number): GoogleTaskProjection | null {
    this.get(taskId);
    const row = this.db.prepare("SELECT * FROM jarvis_google_task_projections WHERE task_id=? AND owner_id=?").get(taskId, this.ownerId);
    if (!row) return null;
    const request = row.request_json === null ? null : JSON.parse(String(row.request_json)) as Record<string, unknown>;
    if (request && hash(request) !== row.request_hash) throw new Error("Google Tasks request checksum mismatch.");
    return { taskId, listId: String(row.list_id), marker: String(row.marker), intentId: String(row.intent_id), taskRevision: Number(row.task_revision),
      payloadHash: String(row.payload_hash), state: row.state as GoogleTaskProjection["state"], remoteId: row.remote_id as string | null,
      request, requestHash: row.request_hash as string | null };
  }
  getGoogleTaskClaim(taskId: number): GoogleTaskClaim | null {
    const projection = this.getGoogleTaskProjection(taskId);
    if (!projection) return null;
    const row = this.db.prepare("SELECT * FROM jarvis_task_outbox WHERE id=? AND owner_id=?").get(projection.intentId, this.ownerId) as unknown as OutboxRow;
    const intent = this.outboxFromRow(row);
    if (intent.taskId !== taskId || intent.taskRevision !== projection.taskRevision || intent.payloadHash !== projection.payloadHash) throw new Error("Google Tasks intent binding mismatch.");
    return { projection, intent };
  }
  claimGoogleTaskInsert(listId: string): GoogleTaskClaim | null {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(listId)) throw new Error("An exact Google Tasks list ID is required.");
    return this.transaction(() => {
      const boundOwner = this.db.prepare("SELECT owner_id FROM jarvis_google_task_lists WHERE list_id=?").get(listId)?.owner_id;
      if (boundOwner && boundOwner !== this.ownerId) throw new Error("Google Tasks list is already bound to another owner.");
      this.db.prepare("INSERT OR IGNORE INTO jarvis_google_task_lists VALUES(?,?)").run(this.ownerId, listId);
      if (this.db.prepare("SELECT list_id FROM jarvis_google_task_lists WHERE owner_id=?").get(this.ownerId)?.list_id !== listId) throw new Error("Google Tasks list binding changed; explicit migration is required.");
      const row = this.db.prepare(`SELECT o.* FROM jarvis_task_outbox o WHERE o.owner_id=? AND o.state='queued'
        AND NOT EXISTS(SELECT 1 FROM jarvis_google_task_projections p WHERE p.task_id=o.task_id)
        AND NOT EXISTS(SELECT 1 FROM jarvis_task_outbox earlier WHERE earlier.task_id=o.task_id AND earlier.task_revision<o.task_revision AND earlier.state<>'synced')
        ORDER BY o.created_at,o.id LIMIT 1`).get(this.ownerId) as unknown as OutboxRow | undefined;
      if (!row) return null;
      this.outboxFromRow(row);
      const claimToken = randomUUID(), marker = `[jarvis-ref:v1:${randomUUID()}]`;
      this.db.prepare("UPDATE jarvis_task_outbox SET state='in_flight',claimed_at=?,claim_token=? WHERE id=?").run(new Date().toISOString(), claimToken, row.id);
      this.db.prepare("INSERT INTO jarvis_google_task_projections VALUES(?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,NULL)")
        .run(row.task_id, this.ownerId, listId, marker, row.id, row.task_revision, row.payload_hash);
      return this.getGoogleTaskClaim(row.task_id);
    });
  }
  prepareGoogleTaskRequest(claim: GoogleTaskClaim, request: Record<string, unknown>): GoogleTaskClaim {
    if (Buffer.byteLength(JSON.stringify(request)) > 48_000 || Object.keys(request).some((key) => !["title", "notes", "status", "due", "completed"].includes(key))) throw new Error("Invalid Google Tasks request.");
    return this.transaction(() => {
      const current = this.boundGoogleClaim(claim);
      if (current.intent.state !== "in_flight" || current.projection.state !== "prepared") throw new Error("Google Tasks insertion is not active.");
      if (current.projection.requestHash && current.projection.requestHash !== hash(request)) throw new Error("Google Tasks request payload mismatch.");
      this.db.prepare("UPDATE jarvis_google_task_projections SET request_json=?,request_hash=? WHERE task_id=? AND owner_id=?")
        .run(JSON.stringify(request), hash(request), claim.intent.taskId, this.ownerId);
      return this.getGoogleTaskClaim(claim.intent.taskId)!;
    });
  }
  resumeUnpreparedGoogleTaskInsert(claim: GoogleTaskClaim): GoogleTaskClaim {
    return this.transaction(() => {
      const current = this.boundGoogleClaim(claim), projection = current.projection;
      // The dispatcher cannot POST until request persistence succeeds. Only this untouched pre-send
      // state proves no send occurred; prepared requests and any recorded outcome remain quarantined.
      if (current.intent.state !== "unknown" || projection.state !== "prepared" || projection.request !== null ||
        projection.requestHash !== null || projection.remoteId !== null ||
        this.db.prepare("SELECT receipt_json FROM jarvis_google_task_projections WHERE task_id=? AND owner_id=?").get(claim.intent.taskId, this.ownerId)?.receipt_json !== null) {
        throw new Error("Google Tasks request cannot be proven unsent.");
      }
      this.db.prepare("UPDATE jarvis_task_outbox SET state='in_flight',claimed_at=?,claim_token=? WHERE id=? AND owner_id=?")
        .run(new Date().toISOString(), randomUUID(), claim.intent.id, this.ownerId);
      return this.getGoogleTaskClaim(claim.intent.taskId)!;
    });
  }
  private boundGoogleClaim(claim: GoogleTaskClaim): GoogleTaskClaim {
    const current = this.getGoogleTaskClaim(claim.intent.taskId);
    if (!current || current.intent.ownerId !== this.ownerId || current.intent.id !== claim.intent.id || current.intent.claimToken !== claim.intent.claimToken ||
      current.intent.payloadHash !== claim.intent.payloadHash || current.projection.marker !== claim.projection.marker || current.projection.listId !== claim.projection.listId) throw new Error("Google Tasks claim binding mismatch.");
    return current;
  }
  settleGoogleTaskInsert(claim: GoogleTaskClaim, receipt: GoogleTaskReceipt): void {
    this.transaction(() => {
      const current = this.boundGoogleClaim(claim), projection = current.projection;
      if (projection.requestHash !== receipt.requestHash) throw new Error("Google Tasks evidence payload mismatch.");
      if (!["synced", "unknown", "conflict"].includes(receipt.outcome)) throw new Error("Invalid Google Tasks outcome.");
      if (projection.state === "synced" || projection.state === "conflict") {
        if (projection.state === receipt.outcome && (receipt.outcome !== "synced" || projection.remoteId === receipt.remote?.id)) return;
        throw new Error("Google Tasks projection already settled.");
      }
      if (!["in_flight", "unknown"].includes(current.intent.state)) throw new Error("Google Tasks intent is not active.");
      if (receipt.outcome === "synced") {
        const remote = receipt.remote, proof = receipt.proof, request = projection.request;
        if (!remote || !request || !proof || proof.matches !== 1 ||
          (proof.kind === "complete_scan" ? !Number.isInteger(proof.pages) || proof.pages < 1 || proof.pages > 20 : proof.kind !== "insert_ack" || proof.pages !== 0 || current.intent.state !== "in_flight") ||
          (current.intent.state === "unknown" && proof.kind !== "complete_scan") ||
          typeof remote.id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(remote.id) || typeof remote.etag !== "string" || !remote.etag ||
          remote.deleted === true || remote.parent || remote.assignmentInfo || Object.entries(request).some(([key, value]) => remote[key] !== value) ||
          (request.due === undefined && remote.due !== undefined)) throw new Error("Google Tasks acknowledgement evidence is invalid.");
      }
      this.db.prepare("UPDATE jarvis_google_task_projections SET state=?,remote_id=?,receipt_json=? WHERE task_id=? AND owner_id=?")
        .run(receipt.outcome, receipt.outcome === "synced" ? String(receipt.remote!.id) : null, JSON.stringify(receipt), claim.intent.taskId, this.ownerId);
      this.db.prepare("UPDATE jarvis_task_outbox SET state=?,external_reference=? WHERE id=? AND owner_id=?")
        .run(receipt.outcome === "synced" ? "synced" : "unknown", receipt.outcome === "synced" ? `${projection.listId}/${String(receipt.remote!.id)}` : null, claim.intent.id, this.ownerId);
    });
  }

  getGoogleTaskSync(taskId: number, listId: string): GoogleTaskSync | null {
    const projection = this.getGoogleTaskProjection(taskId);
    if (!projection) return null;
    if (projection.listId !== listId) throw new Error("Google Tasks list binding mismatch.");
    if (projection.state !== "synced" || !projection.remoteId || !projection.request) return null;
    const read = () => {
      const row = this.db.prepare("SELECT version,data_json FROM jarvis_google_task_sync WHERE task_id=? AND owner_id=?").get(taskId, this.ownerId);
      if (!row) return null;
      const value = JSON.parse(String(row.data_json)) as GoogleTaskSync;
      if (value.version !== row.version || value.taskId !== taskId || value.remoteId !== projection.remoteId || value.listId !== listId || value.marker !== projection.marker) throw new Error("Google Tasks baseline binding mismatch.");
      return value;
    };
    const existing = read(); if (existing) return existing;
    return this.transaction(() => {
      const raced = read(); if (raced) return raced;
      const receipt = JSON.parse(String(this.db.prepare("SELECT receipt_json FROM jarvis_google_task_projections WHERE task_id=? AND owner_id=?").get(taskId, this.ownerId)?.receipt_json)) as GoogleTaskReceipt;
      if (!receipt.remote || receipt.remote.id !== projection.remoteId) throw new Error("Google Tasks baseline acknowledgement is unavailable.");
      const value: GoogleTaskSync = { taskId, listId, remoteId: projection.remoteId!, marker: projection.marker, version: 1, state: "synced",
        localRevision: projection.taskRevision, request: projection.request!, remote: receipt.remote, pending: null };
      this.db.prepare("INSERT INTO jarvis_google_task_sync VALUES(?,?,?,?)").run(taskId, this.ownerId, 1, JSON.stringify(value));
      return value;
    });
  }
  listGoogleTaskSyncs(listId: string): GoogleTaskSync[] {
    const rows = this.db.prepare("SELECT task_id FROM jarvis_google_task_projections WHERE owner_id=? AND list_id=? AND state='synced' ORDER BY task_id LIMIT 2001").all(this.ownerId, listId);
    if (rows.length > 2000) throw new Error("Google Tasks mapping limit exceeded.");
    return rows.map((row) => this.getGoogleTaskSync(Number(row.task_id), listId)!);
  }
  private boundGoogleTaskSync(expected: GoogleTaskSync): GoogleTaskSync {
    const current = this.getGoogleTaskSync(expected.taskId, expected.listId);
    if (!current || current.version !== expected.version || current.remoteId !== expected.remoteId || current.marker !== expected.marker) throw new Error("Google Tasks baseline version conflict.");
    return current;
  }
  private saveGoogleTaskSync(expected: GoogleTaskSync, next: GoogleTaskSync): GoogleTaskSync {
    const value = { ...next, version: expected.version + 1 };
    const result = this.db.prepare("UPDATE jarvis_google_task_sync SET version=?,data_json=? WHERE task_id=? AND owner_id=? AND version=?")
      .run(value.version, JSON.stringify(value), expected.taskId, this.ownerId, expected.version);
    if (result.changes !== 1) throw new Error("Google Tasks baseline version conflict.");
    return value;
  }
  private sameGoogleContent(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    return ["title", "notes", "status", "due", "completed"].every((key) => (left[key] ?? null) === (right[key] ?? null));
  }
  nextGoogleTaskIntent(sync: GoogleTaskSync): TaskSyncIntent | null {
    this.boundGoogleTaskSync(sync);
    const row = this.db.prepare(`SELECT o.* FROM jarvis_task_outbox o WHERE o.owner_id=? AND o.task_id=? AND o.state='queued'
      AND NOT EXISTS(SELECT 1 FROM jarvis_task_outbox earlier WHERE earlier.task_id=o.task_id AND earlier.task_revision<o.task_revision AND earlier.state<>'synced')
      ORDER BY o.task_revision LIMIT 1`).get(this.ownerId, sync.taskId) as unknown as OutboxRow | undefined;
    return row ? this.outboxFromRow(row) : null;
  }
  prepareGoogleTaskPatch(expected: GoogleTaskSync, intent: TaskSyncIntent, request: Record<string, unknown>): GoogleTaskSync {
    if (Buffer.byteLength(JSON.stringify(request)) > 48_000 || Object.keys(request).some((key) => !["title", "notes", "status", "due", "completed"].includes(key))) throw new Error("Invalid Google Tasks request.");
    return this.transaction(() => {
      const current = this.boundGoogleTaskSync(expected), next = this.nextGoogleTaskIntent(current);
      if (current.state !== "synced" || current.pending || !next || next.id !== intent.id || next.payloadHash !== intent.payloadHash || next.ownerId !== this.ownerId) throw new Error("Google Tasks patch claim is not available.");
      const claimToken = randomUUID();
      this.db.prepare("UPDATE jarvis_task_outbox SET state='in_flight',claim_token=?,claimed_at=? WHERE id=? AND owner_id=?")
        .run(claimToken, new Date().toISOString(), next.id, this.ownerId);
      return this.saveGoogleTaskSync(current, { ...current, state: "in_flight", pending: { intentId: next.id, claimToken, payloadHash: next.payloadHash, taskRevision: next.taskRevision, request } });
    });
  }
  private settleGoogleTaskPatchInside(current: GoogleTaskSync, outcome: "unknown" | "conflict" | "detached" | "synced", remote?: Record<string, unknown>): GoogleTaskSync {
    const pending = current.pending;
    if (!pending) throw new Error("Google Tasks patch is not active.");
    const row = this.db.prepare("SELECT * FROM jarvis_task_outbox WHERE id=? AND owner_id=?").get(pending.intentId, this.ownerId) as unknown as OutboxRow | undefined;
    if (!row || row.claim_token !== pending.claimToken || row.payload_hash !== pending.payloadHash || !["in_flight", "unknown"].includes(row.state)) throw new Error("Google Tasks patch claim binding mismatch.");
    this.outboxFromRow(row);
    if (outcome === "synced" && (!remote || remote.id !== current.remoteId || remote.deleted || remote.parent || remote.assignmentInfo || !this.sameGoogleContent(pending.request, remote))) throw new Error("Google Tasks patch acknowledgement mismatch.");
    this.db.prepare("UPDATE jarvis_task_outbox SET state=?,external_reference=? WHERE id=? AND owner_id=?")
      .run(outcome === "synced" ? "synced" : "unknown", outcome === "synced" ? `${current.listId}/${current.remoteId}` : null, pending.intentId, this.ownerId);
    return this.saveGoogleTaskSync(current, { ...current, state: outcome, ...(outcome === "synced" ? { localRevision: pending.taskRevision, request: pending.request, remote: remote!, pending: null } : {}) });
  }
  settleGoogleTaskPatch(expected: GoogleTaskSync, outcome: "unknown" | "conflict" | "detached" | "synced", remote?: Record<string, unknown>): GoogleTaskSync {
    return this.transaction(() => {
      const current = this.boundGoogleTaskSync(expected);
      if (current.state !== "in_flight") throw new Error("Google Tasks patch acknowledgement is not active.");
      return this.settleGoogleTaskPatchInside(current, outcome, remote);
    });
  }
  observeGoogleTask(expected: GoogleTaskSync, remote: Record<string, unknown> | null): GoogleTaskSync["state"] {
    return this.transaction(() => {
      const current = this.boundGoogleTaskSync(expected);
      if (["conflict", "detached", "in_flight"].includes(current.state)) return current.state;
      if (remote && (remote.id !== current.remoteId || typeof remote.etag !== "string" || !remote.etag || typeof remote.updated !== "string")) throw new Error("Google Tasks observation binding mismatch.");
      if (remote && remoteInstantOrder(remote.updated) < remoteInstantOrder(current.remote.updated)) {
        return (current.pending ? this.settleGoogleTaskPatchInside(current, "conflict") : this.saveGoogleTaskSync(current, { ...current, state: "conflict" })).state;
      }
      if (!remote || remote.deleted === true) {
        return (current.pending ? this.settleGoogleTaskPatchInside(current, "detached") : this.saveGoogleTaskSync(current, { ...current, state: "detached" })).state;
      }
      if (remote.parent || remote.assignmentInfo) {
        return (current.pending ? this.settleGoogleTaskPatchInside(current, "conflict") : this.saveGoogleTaskSync(current, { ...current, state: "conflict" })).state;
      }
      if (current.pending) {
        if (this.sameGoogleContent(current.pending.request, remote)) return this.settleGoogleTaskPatchInside(current, "synced", remote).state;
        if (this.sameGoogleContent(current.remote, remote) && current.remote.etag === remote.etag && current.remote.updated === remote.updated) return "unknown";
        return this.settleGoogleTaskPatchInside(current, "conflict").state;
      }
      if (this.sameGoogleContent(current.remote, remote)) {
        if (current.remote.etag !== remote.etag || current.remote.updated !== remote.updated) this.saveGoogleTaskSync(current, { ...current, remote });
        return "synced";
      }
      const local = this.get(current.taskId);
      if (local.revision !== current.localRevision || remote.notes !== current.remote.notes || remote.parent || remote.assignmentInfo ||
        typeof remote.title !== "string" || !remote.title.trim() || remote.title.length > 500 || !["needsAction", "completed"].includes(String(remote.status))) {
        return this.saveGoogleTaskSync(current, { ...current, state: "conflict" }).state;
      }
      const plannedDate = remote.due == null ? null : canonicalDate(String(remote.due).slice(0, 10), "remote planned day");
      // This trusted provider path retains remote completion precision without widening local user input rules.
      const remoteCompletedAt = remote.status === "completed" && typeof remote.completed === "string" ? remote.completed : null;
      const updated = this.applyUpdate({ id: local.id, expectedRevision: local.revision, sourceSystem: "google-tasks-import",
        idempotencyKey: `remote-${hash({ listId: current.listId, remoteId: current.remoteId, remote })}`, changes: {
          title: remote.title, plannedDate, lifecycle: remote.status === "completed" ? "done" : local.lifecycle === "done" ? "ready" : local.lifecycle
        } }, undefined, { reference: `${current.listId}/${current.remoteId}`, completedAt: remoteCompletedAt });
      this.saveGoogleTaskSync(current, { ...current, localRevision: updated.revision, remote, request: Object.fromEntries(["title", "notes", "status", "due", "completed"].map((key) => [key, remote[key] ?? null])) });
      return "synced";
    });
  }

  create(input: TaskCreateInput): JarvisTask {
    const title = text(input.title, "title", 500), subject = text(input.subject, "subject", 200);
    const source = text(input.sourceSystem, "source", 120), key = text(input.legacyId ?? randomUUID(), "idempotency key", 200);
    // Keep Alex's existing backing provenance untouched. Namespace other principals and escape logical
    // inputs resembling the reserved namespace; the one-to-one metadata retains their original provenance.
    const namespaced = this.ownerId !== "alex" || source.startsWith("jarvis-owner:");
    const backingSource = namespaced ? `jarvis-owner:${hash(this.ownerId)}` : source;
    const backingKey = namespaced ? hash({ source, key }) : key;
    if (input.id !== undefined && (!Number.isSafeInteger(input.id) || input.id < 1)) throw new Error("Invalid task ID.");
    if (input.status !== undefined && !["pending", "completed"].includes(input.status)) throw new Error("Invalid task status.");
    if (input.deadline && (input.dueDate != null || input.dueAt != null)) throw new Error("Use deadline or legacy dates, not both.");
    const dueDate = input.dueDate == null ? null : canonicalDate(input.dueDate, "due date");
    const dueAt = input.dueAt == null ? null : canonicalInstant(input.dueAt, "due instant");
    const precise = input.deadline ? deadline(input.deadline) : fromLegacyDate(dueDate, dueAt, "reported");
    const dates = input.deadline ? { dueDate: precise.date ?? null, dueAt: precise.at ?? null } : { dueDate, dueAt };
    const kind = input.kind ?? "unspecified";
    if (!kinds.includes(kind)) throw new Error("Invalid task kind.");
    const metadata: Omit<TaskMetadata, "updatedAt"> = { ...(namespaced ? { sourceIdentity: { sourceSystem: source, legacyId: key } } : {}),
      kind, lifecycle: input.status === "completed" ? "done" : "inbox", deadline: precise,
      plannedDate: input.plannedDate == null ? null : canonicalDate(input.plannedDate, "planned date"),
      description: text(input.description ?? "", "description", 4000, true), completionCriteria: text(input.completionCriteria ?? "", "completion criteria", 2000, true),
      completionEvidence: null, evidenceState: "unknown" };
    const payloadHash = hash({ action: "create", id: input.id ?? null, title, subject, ...dates, metadata });
    return this.transaction(() => {
      const replay = this.replay(source, key, payloadHash);
      if (replay) return replay;
      const candidates = this.db.prepare(`${joinSql} WHERE m.owner_id=? AND ((t.source_system=? AND t.legacy_id=?) OR (t.source_system=? AND t.legacy_id=?)) ORDER BY t.id`)
        .all(this.ownerId, source, key, backingSource, backingKey) as unknown as TaskRow[];
      const existing = candidates.find((row) => { const task = fromRow(row); return task.sourceSystem === source && task.legacyId === key; });
      if (existing) {
        if (existing.owner_id !== this.ownerId) throw new Error("Task is not available to this owner.");
        if (existing.title !== title || existing.subject !== subject || existing.due_date !== dates.dueDate || existing.due_at !== dates.dueAt || (input.id !== undefined && existing.id !== input.id)) {
          throw new Error("Task idempotency key conflicts with migrated content.");
        }
        return this.record(source, key, payloadHash, fromRow(existing));
      }
      const now = input.importedAt ?? new Date().toISOString();
      const insert = this.db.prepare(`INSERT INTO jarvis_tasks (${input.id === undefined ? "" : "id,"}title,subject,due_date,due_at,status,completed_at,source_system,legacy_id,source_hash,imported_at)
        VALUES (${input.id === undefined ? "" : "?,"}?,?,?,?,?,NULL,?,?,?,?)`);
      const result = insert.run(...(input.id === undefined ? [] : [input.id]), title, subject, dates.dueDate, dates.dueAt, input.status ?? "pending", backingSource, backingKey,
        input.sourceHash ?? hash({ title, subject, ...dates }), now);
      const id = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO jarvis_task_metadata VALUES(?,?,1,?)").run(id, this.ownerId, JSON.stringify({ ...metadata, updatedAt: now }));
      return this.record(source, key, payloadHash, this.get(id));
    });
  }

  update(input: TaskUpdateInput, completedAt?: string): JarvisTask {
    return this.transaction(() => this.applyUpdate(input, completedAt));
  }
  private applyUpdate(input: TaskUpdateInput, completedAt?: string, remoteOrigin?: { reference: string; completedAt: string | null }): JarvisTask {
    const source = text(input.sourceSystem, "source", 120), key = text(input.idempotencyKey, "idempotency key", 200);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("An expected revision is required.");
    const changes = input.changes;
    const allowed = new Set(["title", "subject", "dueDate", "dueAt", "kind", "deadline", "plannedDate", "description", "completionCriteria", "completionEvidence", "lifecycle"]);
    if (Object.keys(changes).some((field) => !allowed.has(field))) throw new Error("Unsupported task change.");
    const payloadHash = hash({ action: "update", id: input.id, expectedRevision: input.expectedRevision,
      changes: Object.fromEntries(Object.entries(changes).sort(([a], [b]) => a.localeCompare(b))), completedAt: completedAt ?? null });
    return (() => {
      const replay = this.replay(source, key, payloadHash);
      if (replay) return replay;
      const current = this.get(input.id);
      if (current.revision !== input.expectedRevision) throw new Error("Task revision conflict; reload before editing.");
      const kind = changes.kind ?? current.kind, lifecycle = changes.lifecycle ?? current.lifecycle;
      if (!kinds.includes(kind) || !lifecycles.includes(lifecycle)) throw new Error("Invalid task kind or lifecycle.");
      let dueDate = changes.dueDate === undefined ? current.dueDate : changes.dueDate === null ? null : canonicalDate(changes.dueDate, "due date");
      let dueAt = changes.dueAt === undefined ? current.dueAt : changes.dueAt === null ? null : canonicalInstant(changes.dueAt, "due instant");
      if (changes.dueDate !== undefined && changes.dueAt === undefined) dueAt = null;
      if (changes.dueAt !== undefined && changes.dueDate === undefined) dueDate = null;
      if (changes.deadline && (changes.dueDate !== undefined || changes.dueAt !== undefined)) throw new Error("Use deadline or legacy dates, not both.");
      const precise = changes.deadline ? deadline(changes.deadline) : changes.dueDate !== undefined || changes.dueAt !== undefined ? fromLegacyDate(dueDate, dueAt, "reported") : current.deadline;
      if (changes.deadline) { dueDate = precise.date ?? null; dueAt = precise.at ?? null; }
      const now = new Date().toISOString();
      const metadata: TaskMetadata = { ...(current.sourceIdentity ? { sourceIdentity: current.sourceIdentity } : {}), kind, lifecycle, deadline: precise,
        plannedDate: changes.plannedDate === undefined ? current.plannedDate : changes.plannedDate === null ? null : canonicalDate(changes.plannedDate, "planned date"),
        description: text(changes.description ?? current.description, "description", 4000, true),
        completionCriteria: text(changes.completionCriteria ?? current.completionCriteria, "completion criteria", 2000, true),
        completionEvidence: changes.completionEvidence === undefined ? current.completionEvidence : changes.completionEvidence === null ? null : text(changes.completionEvidence, "completion evidence", 2000),
        evidenceState: lifecycle === "done" || changes.completionEvidence ? "reported" : current.evidenceState, updatedAt: now };
      this.db.prepare("UPDATE jarvis_tasks SET title=?,subject=?,due_date=?,due_at=?,status=?,completed_at=? WHERE id=?").run(
        text(changes.title ?? current.title, "title", 500), text(changes.subject ?? current.subject, "subject", 200), dueDate, dueAt,
        lifecycle === "done" ? "completed" : "pending", lifecycle === "done" ? remoteOrigin ? remoteOrigin.completedAt : current.completedAt ?? (completedAt ? canonicalInstant(completedAt, "completion instant") : now) : null, input.id);
      this.db.prepare("UPDATE jarvis_task_metadata SET revision=revision+1,data_json=? WHERE task_id=? AND owner_id=? AND revision=?")
        .run(JSON.stringify(metadata), input.id, this.ownerId, input.expectedRevision);
      return this.record(source, key, payloadHash, this.get(input.id), remoteOrigin?.reference);
    })();
  }

  complete(id: number, completedAt?: string, options?: { expectedRevision: number; idempotencyKey: string }): JarvisTask {
    // Compatibility callers are trusted local code; the public tool requires an explicit revision and intent key.
    if (!options) {
      const current = this.get(id);
      if (current.lifecycle === "done") return current;
      options = { expectedRevision: current.revision, idempotencyKey: `legacy-complete-${id}-${current.revision}` };
    }
    return this.update({ id, expectedRevision: options.expectedRevision, idempotencyKey: options.idempotencyKey,
      sourceSystem: "jarvis-task-completion", changes: { lifecycle: "done" } }, completedAt);
  }
}
