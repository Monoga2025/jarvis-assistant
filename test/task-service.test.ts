import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { LegacyStore } from "../plugins/jarvis-tools/src/legacy.js";
import { createSnapshot, restoreSnapshot } from "../scripts/sqlite-snapshot.js";
import plugin from "../plugins/jarvis-tools/src/index.js";
import { NotificationStore } from "../plugins/jarvis-tools/src/notifications.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-tasks-"));
  roots.push(root);
  return { root, file: path.join(root, "jarvis.sqlite") };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

describe("canonical task service through LegacyStore", () => {
  it("namespaces new backing identities per owner while preserving Alex provenance and logical replay keys", async () => {
    const f = await fixture();
    let alex = new LegacyStore(f.file);
    let sam = new LegacyStore(f.file, { ownerId: "sam" });
    const input = { title: "Same source key", subject: "Personal", sourceSystem: "jarvis-agent", legacyId: "capture-one" };
    try {
      const first = alex.createTask(input);
      const second = sam.createTask(input);
      assert.notEqual(second.id, first.id);
      assert.equal(second.ownerId, "sam");
      assert.equal(second.sourceSystem, input.sourceSystem);
      assert.equal(second.legacyId, input.legacyId);
      const inspect = new DatabaseSync(f.file, { readOnly: true });
      try {
        assert.deepEqual({ ...inspect.prepare("SELECT source_system,legacy_id FROM jarvis_tasks WHERE id=?").get(first.id) },
          { source_system: input.sourceSystem, legacy_id: input.legacyId });
        const backing = inspect.prepare("SELECT source_system,legacy_id FROM jarvis_tasks WHERE id=?").get(second.id)!;
        const escaped = alex.createTask({ ...input, sourceSystem: String(backing.source_system), legacyId: String(backing.legacy_id) });
        assert.notEqual(escaped.id, second.id, "logical input cannot impersonate another owner's reserved backing namespace");
      } finally { inspect.close(); }
      alex.close(); sam.close();
      alex = new LegacyStore(f.file);
      sam = new LegacyStore(f.file, { ownerId: "sam" });
      assert.equal(alex.createTask(input).id, first.id);
      assert.equal(sam.createTask(input).id, second.id);
      assert.throws(() => sam.createTask({ ...input, title: "Changed payload" }), /idempotency/i);
      const edited = sam.updateTask({ id: second.id, expectedRevision: 1, sourceSystem: "jarvis-agent", idempotencyKey: "edit", changes: { title: "Changed via edit" } });
      assert.equal(edited.sourceSystem, input.sourceSystem);
      assert.equal(edited.legacyId, input.legacyId);
    } finally { alex.close(); sam.close(); }
  });
  it("keeps trusted completion compatibility idempotent after an explicit reopen", async () => {
    const f = await fixture();
    const store = new LegacyStore(f.file);
    try {
      const created = store.createTask({ title: "Task", subject: "X", sourceSystem: "test", legacyId: "cycle" });
      const done = store.completeTask(created.id);
      store.updateTask({ id: created.id, expectedRevision: done.revision, sourceSystem: "test", idempotencyKey: "reopen", changes: { lifecycle: "ready" } });
      const doneAgain = store.completeTask(created.id);
      assert.equal(doneAgain.lifecycle, "done");
      assert.equal(doneAgain.revision, 4);
      assert.equal(store.completeTask(created.id).revision, 4);
    } finally { store.close(); }
  });
  it("does not expose another owner's tasks through Alex's existing notification query", async () => {
    const f = await fixture();
    const other = new LegacyStore(f.file, { ownerId: "sam" });
    other.createTask({ title: "Private task", subject: "Private", dueDate: "2026-09-09", sourceSystem: "test", legacyId: "private" });
    other.close();
    const notifications = new NotificationStore(f.file);
    try { assert.equal(notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789"), null); }
    finally { notifications.close(); }
  });
  it("migrates a restored legacy snapshot additively without changing task identity or precision", async () => {
    const f = await fixture();
    const old = new DatabaseSync(f.file);
    old.exec(`CREATE TABLE jarvis_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,subject TEXT NOT NULL,due_date TEXT,due_at TEXT,
      status TEXT NOT NULL,completed_at TEXT,source_system TEXT NOT NULL,legacy_id TEXT NOT NULL,source_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,UNIQUE(source_system,legacy_id));
      INSERT INTO jarvis_tasks VALUES(18,'Circuit quiz','Circuits','2026-09-10',NULL,'pending',NULL,'legacy','18','old-hash','2026-09-01T00:00:00Z');`);
    const oldRow = old.prepare("SELECT * FROM jarvis_tasks").get();
    old.close();
    const candidate = "c".repeat(40);
    const snapshot = path.join(f.root, "baseline");
    const manifest = await createSnapshot({ sourcePath: f.file, outputDirectory: snapshot, candidateRevision: candidate, deploymentId: "isolated-fixture" });
    const restore = path.join(f.root, "restore");
    await restoreSnapshot({ snapshotDirectory: snapshot, restoreDirectory: restore, expectedCandidateRevision: candidate,
      expectedSchemaSha256: manifest.database.schemaSha256 });
    const migratedPath = path.join(restore, "jarvis.sqlite");
    const store = new LegacyStore(migratedPath);
    try {
      const task = store.listTasks()[0]!;
      assert.equal(task.id, 18);
      assert.equal(task.ownerId, "alex");
      assert.equal(task.revision, 1);
      assert.equal(task.lifecycle, "inbox");
      assert.equal(task.deadline.precision, "day");
      assert.equal(task.deadline.confidence, "unknown");
      assert.equal(task.dueAt, null);
    } finally { store.close(); }
    const migrated = new DatabaseSync(migratedPath);
    try {
      assert.deepEqual(migrated.prepare("SELECT * FROM jarvis_tasks").get(), oldRow);
      assert.deepEqual(migrated.prepare("SELECT version FROM jarvis_task_migrations ORDER BY version").all().map((row) => row.version), [1, 2, 3]);
    } finally { migrated.close(); }
    const restarted = new LegacyStore(migratedPath);
    try { assert.equal(restarted.listTasks()[0]?.revision, 1); } finally { restarted.close(); }
    const rollback = new DatabaseSync(path.join(snapshot, "jarvis.sqlite"), { readOnly: true });
    try { assert.equal(rollback.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='jarvis_task_metadata'").get()?.count, 0); }
    finally { rollback.close(); }
  });

  it("preserves unknown/range/day/time precision and separates planned date from deadline", async () => {
    const f = await fixture();
    const store = new LegacyStore(f.file);
    try {
      const task = store.createTask({ title: "Submit bottles", subject: "CAD", sourceSystem: "test", legacyId: "capture",
        kind: "homework", deadline: { precision: "range", startDate: "2026-09-14", endDate: "2026-09-20", originalText: "next week", confidence: "reported" },
        plannedDate: "2026-09-12" });
      assert.equal(task.deadline.precision, "range");
      assert.equal(task.dueDate, null);
      assert.equal(task.dueAt, null);
      assert.equal(task.plannedDate, "2026-09-12");
      assert.equal(task.kind, "homework");
      const unknown = store.createTask({ title: "Start project", subject: "Statistics", sourceSystem: "test", legacyId: "unknown" });
      assert.equal(unknown.deadline.precision, "unknown");
      assert.equal(unknown.kind, "unspecified");
      const timed = store.createTask({ title: "Timed", subject: "X", sourceSystem: "test", legacyId: "timed", dueAt: "2026-09-10T09:00:00-05:00" });
      assert.equal(timed.deadline.precision, "time");
      const rescheduled = store.updateTask({ id: timed.id, expectedRevision: 1, sourceSystem: "test", idempotencyKey: "day-only", changes: { dueDate: "2026-09-14" } });
      assert.equal(rescheduled.deadline.precision, "day");
      assert.equal(rescheduled.dueAt, null, "a new date-only instruction must not inherit the old exact time");
      assert.throws(() => store.createTask({ title: "Bad date", subject: "X", sourceSystem: "test", dueDate: "2026-02-30" }), /date|YYYY/);
    } finally { store.close(); }
  });

  it("enforces owner, revision and payload-bound replay through capture, update and completion", async () => {
    const f = await fixture();
    const store = new LegacyStore(f.file);
    const other = new LegacyStore(f.file, { ownerId: "sam" });
    try {
      const input = { title: "Understand exercise", subject: "Calculus", sourceSystem: "test", legacyId: "capture", sourceHash: "caller-hash" };
      const task = store.createTask(input);
      assert.throws(() => store.createTask({ ...input, title: "Different payload" }), /idempotency/i);
      assert.deepEqual(other.listTasks("all"), []);
      assert.throws(() => other.updateTask({ id: task.id, expectedRevision: 1, idempotencyKey: "foreign", sourceSystem: "test", changes: { title: "Foreign" } }), /not available/);
      const update = { id: task.id, expectedRevision: task.revision, idempotencyKey: "update", sourceSystem: "test",
        changes: { lifecycle: "in_progress" as const, description: "Explain each step", completionCriteria: "Correct solution and explanation" } };
      const updated = store.updateTask(update);
      assert.equal(updated.revision, 2);
      assert.equal(updated.lifecycle, "in_progress");
      assert.deepEqual(store.updateTask(update), updated);
      assert.throws(() => store.updateTask({ ...update, idempotencyKey: "stale" }), /revision/i);
      assert.throws(() => store.updateTask({ ...update, changes: { title: "Another" } }), /idempotency/i);
      const completed = store.completeTask(task.id, undefined, { expectedRevision: 2, idempotencyKey: "complete" });
      assert.equal(completed.lifecycle, "done");
      assert.equal(completed.status, "completed");
      assert.equal(completed.revision, 3);
      assert.equal(completed.completionEvidence, null);
      assert.deepEqual(store.completeTask(task.id, undefined, { expectedRevision: 2, idempotencyKey: "complete" }), completed);
      assert.equal(store.listTasks("completed")[0]?.revision, 3);
    } finally { other.close(); store.close(); }
  });
});

describe("existing task tool shared service path", () => {
  it("captures, lists, updates and completes the same persisted task without adding tools", async () => {
    const f = await fixture();
    const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }> = [];
    plugin.register({ pluginConfig: { primaryCalendarId: "primary", managedCalendarId: "managed", importDirectory: "C:/bounded", databasePath: f.file,
      googleClientIdFile: "C:/credentials/id", googleClientSecretFile: "C:/credentials/secret", googleRefreshTokenFile: "C:/credentials/refresh" },
      registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerMemoryPromptPreparation() {}, registerInteractiveHandler() {},
    } as never);
    async function call(name: string, params: unknown) {
      const result = await tools.find((tool) => tool.name === name)!.execute("call", params);
      return JSON.parse(result.content.find((item) => item.type === "text")!.text!);
    }
    const created = await call("task_create", { title: "Study", subject: "Circuits", idempotencyKey: "capture", dueDate: "2026-09-10" });
    assert.equal(created.revision, 1);
    const updated = await call("task_create", { taskId: created.id, expectedRevision: 1, title: "Study Thévenin", subject: "Circuits", idempotencyKey: "update" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.revision, 2);
    assert.equal(updated.dueDate, "2026-09-10");
    await call("task_complete", { id: created.id, expectedRevision: 2, idempotencyKey: "complete" });
    const listed = await call("task_list", { status: "all" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].lifecycle, "done");
    assert.equal(listed[0].revision, 3);
  });
});

describe("atomic persistent task sync outbox", () => {
  it("rolls back create and edit when outbox persistence fails", async () => {
    const f = await fixture();
    const store = new LegacyStore(f.file);
    const inspector = new DatabaseSync(f.file);
    try {
      const task = store.createTask({ title: "Original", subject: "X", sourceSystem: "test", legacyId: "first" });
      inspector.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON jarvis_task_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
      assert.throws(() => store.createTask({ title: "Not committed", subject: "X", sourceSystem: "test", legacyId: "second" }), /outbox unavailable/);
      assert.throws(() => store.updateTask({ id: task.id, expectedRevision: 1, sourceSystem: "test", idempotencyKey: "edit", changes: { title: "Not committed" } }), /outbox unavailable/);
      assert.equal(store.listTasks("all").length, 1);
      assert.equal(store.listTasks("all")[0]?.title, "Original");
      assert.equal(store.listTasks("all")[0]?.revision, 1);
      assert.equal(inspector.prepare("SELECT COUNT(*) AS count FROM jarvis_task_intents").get()?.count, 1);
      assert.equal(store.listTaskSyncIntents().length, 1);
    } finally { inspector.close(); store.close(); }
  });

  it("persists one payload-bound intent per revision and owner, surviving restart and unknown outcomes without resend", async () => {
    const f = await fixture();
    let store = new LegacyStore(f.file);
    let other = new LegacyStore(f.file, { ownerId: "sam" });
    try {
      const input = { title: "Quiz", subject: "Circuits", sourceSystem: "test", legacyId: "capture", dueDate: "2026-09-10" };
      const task = store.createTask(input);
      store.createTask(input);
      assert.equal(task.syncState, "queued");
      assert.equal(store.listTaskSyncIntents().length, 1);
      assert.deepEqual(other.listTaskSyncIntents(), []);
      const first = store.claimTaskSyncIntents()[0]!;
      assert.equal(first.taskRevision, 1);
      assert.equal(first.payload.deadline.precision, "day");
      assert.equal(first.payload.dueAt, null);
      assert.equal(first.payloadHash.length, 64);
      assert.deepEqual(store.claimTaskSyncIntents(), []);
      assert.throws(() => other.settleTaskSyncIntent({ id: first.id, claimToken: first.claimToken!, outcome: "synced", externalReference: "list/task" }), /not available/);
      store.updateTask({ id: task.id, expectedRevision: 1, sourceSystem: "test", idempotencyKey: "update", changes: { title: "Quiz corrected" } });
      assert.deepEqual(store.claimTaskSyncIntents(), [], "a later revision must not overtake an unacknowledged earlier effect");
      other.close(); store.close();
      store = new LegacyStore(f.file);
      other = new LegacyStore(f.file, { ownerId: "sam" });
      assert.deepEqual(store.claimTaskSyncIntents(), [], "restart must not blindly reclaim in-flight inserts");
      assert.equal(store.markInterruptedTaskSyncUnknown(), 1);
      assert.equal(store.listTaskSyncIntents()[0]?.state, "unknown");
      assert.equal(store.listTasks()[0]?.syncState, "unknown", "a newer queued revision must not hide the unknown earlier effect");
      assert.deepEqual(store.claimTaskSyncIntents(), [], "unknown effect requires remote reconciliation before any resend");
    } finally { other.close(); store.close(); }
  });

  it("requires an acknowledged external reference and valid claim token before reporting synced", async () => {
    const f = await fixture();
    const store = new LegacyStore(f.file);
    try {
      const task = store.createTask({ title: "Task", subject: "X", sourceSystem: "test", legacyId: "one" });
      const claim = store.claimTaskSyncIntents()[0]!;
      assert.throws(() => store.settleTaskSyncIntent({ id: claim.id, claimToken: "incorrect", outcome: "synced", externalReference: "list/task" }), /claim/i);
      assert.throws(() => store.settleTaskSyncIntent({ id: claim.id, claimToken: claim.claimToken!, outcome: "synced" }), /reference/i);
      store.settleTaskSyncIntent({ id: claim.id, claimToken: claim.claimToken!, outcome: "synced", externalReference: "list/task" });
      assert.equal(store.listTasks()[0]?.syncState, "synced");
      store.settleTaskSyncIntent({ id: claim.id, claimToken: claim.claimToken!, outcome: "synced", externalReference: "list/task" });
      store.completeTask(task.id, undefined, { expectedRevision: 1, idempotencyKey: "done" });
      assert.equal(store.listTasks("completed")[0]?.syncState, "queued");
      assert.equal(store.claimTaskSyncIntents()[0]?.taskRevision, 2);
    } finally { store.close(); }
  });
});
