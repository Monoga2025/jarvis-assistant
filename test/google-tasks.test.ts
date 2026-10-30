import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { LegacyStore } from "../plugins/jarvis-tools/src/legacy.js";
import { TaskService } from "../plugins/jarvis-tools/src/task-service.js";
import { canonicalInstant } from "../plugins/jarvis-tools/src/date-time.js";
import { GoogleTasksClient, GoogleTasksDispatcher, type GoogleTask } from "../plugins/jarvis-tools/src/google-tasks.js";

const roots: string[] = [];
async function fixture(owner = "alex") {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-google-tasks-")); roots.push(root);
  const file = path.join(root, "fixture.sqlite");
  const legacy = new LegacyStore(file, { ownerId: owner });
  const db = new DatabaseSync(file); db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;");
  const service = new TaskService(db, owner);
  return { file, legacy, db, service, close: () => { db.close(); legacy.close(); } };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
const input = { title: "Review calculus", subject: "Calculus", sourceSystem: "telegram", legacyId: "message-1",
  deadline: { precision: "time" as const, at: "2026-09-14T13:00:00-05:00", sourceReference: "message-1" },
  plannedDate: "2026-09-12", description: "Understand the exercise", completionCriteria: "Explain each step" };
const token = { getAccessToken: async () => "fixture-access-token" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function remote(body: unknown, id = "remote-1"): GoogleTask {
  return { ...(body as object), kind: "tasks#task", id, etag: '"v1"', updated: "2026-09-09T15:00:00Z" } as GoogleTask;
}

describe("Google Tasks insertion from the canonical outbox", () => {
  it("recovers a crash after claim but before request preparation without treating a prior POST as unsent", async () => {
    const f = await fixture();
    const task = f.legacy.createTask(input);
    const original = f.service.claimGoogleTaskInsert("dedicated-list")!;
    assert.equal(original.projection.request, null);
    f.close();
    const db = new DatabaseSync(f.file);
    try {
      const restarted = new TaskService(db);
      assert.equal(restarted.markInterruptedSyncUnknown(), 1);
      let posts = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (_url, options) => {
        assert.equal(options?.method, "POST"); posts++;
        return json({ ...remote(JSON.parse(String(options?.body))), updated: "2026-09-09T15:00:00.123456Z" });
      });
      const dispatcher = new GoogleTasksDispatcher(restarted, client, { enabled: true });
      assert.equal(posts, 0);
      assert.equal(await dispatcher.reconcileUnknown(task.id), "synced");
      assert.equal(posts, 1);
      assert.equal(await dispatcher.reconcileUnknown(task.id), "synced");
      assert.equal(await dispatcher.dispatchOne(), "idle"); assert.equal(posts, 1);
      const recovered = restarted.getGoogleTaskClaim(task.id)!;
      assert.equal(recovered.intent.id, original.intent.id);
      assert.equal(recovered.projection.marker, original.projection.marker);
      assert.notEqual(recovered.intent.claimToken, original.intent.claimToken);
      assert.throws(() => restarted.prepareGoogleTaskRequest(original, {}), /binding/i);
    } finally { db.close(); }
  });

  it("does not resume a prepared unknown insertion when a complete scan finds nothing", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input);
      const claim = f.service.claimGoogleTaskInsert("dedicated-list")!;
      f.service.prepareGoogleTaskRequest(claim, { title: input.title, notes: claim.projection.marker, status: "needsAction" });
      f.service.markInterruptedSyncUnknown(); let posts = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (_url, options) => {
        if (options?.method === "POST") posts++;
        return json({ items: [] });
      });
      const dispatcher = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      assert.equal(await dispatcher.reconcileUnknown(task.id), "unknown");
      assert.equal(await dispatcher.dispatchOne(), "idle"); assert.equal(posts, 0);
    } finally { f.close(); }
  });

  it("detects a sub-millisecond remote update between recovery scan and readback", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input); let created: GoogleTask; let posts = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (url, options) => {
        if (options?.method === "POST") { posts++; created = { ...remote(JSON.parse(String(options.body))), updated: "2026-09-09T15:00:00.123456789Z" }; throw new Error("lost response"); }
        return json(String(url).includes("/remote-1?") ? { ...created!, updated: "2026-09-09T15:00:00.123456790Z" } : { items: [created!] });
      });
      const dispatcher = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      await dispatcher.dispatchOne();
      assert.equal(await dispatcher.reconcileUnknown(task.id), "conflict"); assert.equal(posts, 1);
    } finally { f.close(); }
  });

  it("defaults disabled, then inserts only after commit and preserves canonical precision and IDs", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input);
      let calls = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (url, options) => {
        calls++;
        assert.equal(new URL(String(url)).hostname, "tasks.googleapis.com");
        assert.equal(new URL(String(url)).pathname, "/tasks/v1/lists/dedicated-list/tasks");
        assert.equal(options?.method, "POST"); assert.equal(options?.redirect, "error");
        // Another connection can write: no provider callback runs inside the store transaction.
        const other = new DatabaseSync(f.file); other.exec("BEGIN IMMEDIATE; ROLLBACK"); other.close();
        const body = JSON.parse(String(options?.body));
        assert.equal(body.due, "2026-09-12T00:00:00.000Z");
        assert.match(body.notes, /Deadline:/); assert.match(body.notes, /\[jarvis-ref:v1:/);
        assert.equal(body.status, "needsAction"); assert.equal(body.id, undefined);
        return json(remote(body));
      });
      assert.equal(await new GoogleTasksDispatcher(f.service, client).dispatchOne(), "disabled");
      assert.equal(calls, 0); assert.equal(f.service.listSyncIntents()[0]?.state, "queued");
      const dispatcher = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      assert.equal(await dispatcher.dispatchOne(), "synced");
      assert.equal(await dispatcher.dispatchOne(), "idle"); assert.equal(calls, 1);
      const projection = f.service.getGoogleTaskProjection(task.id)!;
      assert.equal(projection.remoteId, "remote-1"); assert.equal(projection.listId, "dedicated-list");
      assert.equal(projection.taskRevision, 1); assert.equal(projection.state, "synced");
      assert.deepEqual(f.legacy.listTasks()[0]?.deadline, task.deadline);
      assert.equal(f.legacy.listTasks()[0]?.id, task.id); assert.equal(f.legacy.listTasks()[0]?.syncState, "synced");
    } finally { f.close(); }
  });

  it("does not turn a deadline into a planned day and bounds remote notes without truncating local data", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask({ ...input, plannedDate: null, description: "d".repeat(4000), completionCriteria: "c".repeat(2000) });
      const client = new GoogleTasksClient("dedicated-list", token, async (_url, options) => {
        const body = JSON.parse(String(options?.body)); assert.equal(body.due, undefined);
        assert.ok(body.notes.length <= 8192); return json(remote(body));
      });
      await new GoogleTasksDispatcher(f.service, client, { enabled: true }).dispatchOne();
      assert.equal(f.service.list()[0]?.description.length, 4000);
      assert.deepEqual(f.service.list()[0]?.deadline, task.deadline);
    } finally { f.close(); }
  });

  it("serializes competing dispatchers, persists mapping on restart, and leaves mapped edits queued", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input); let calls = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (_url, options) => { calls++; return json(remote(JSON.parse(String(options?.body)))); });
      const a = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      const b = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      assert.deepEqual((await Promise.all([a.dispatchOne(), b.dispatchOne()])).sort(), ["idle", "synced"]);
      const restarted = new TaskService(f.db);
      assert.equal(restarted.getGoogleTaskProjection(task.id)?.remoteId, "remote-1");
      f.legacy.completeTask(task.id);
      assert.equal(await new GoogleTasksDispatcher(restarted, client, { enabled: true }).dispatchOne(), "idle");
      assert.equal(restarted.listSyncIntents()[1]?.state, "queued"); assert.equal(calls, 1);
    } finally { f.close(); }
  });

  it("reconciles a lost insert response through every page plus exact-ID readback, never re-inserting", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input); let created: GoogleTask; let posts = 0; let pages = 0;
      const client = new GoogleTasksClient("dedicated-list", token, async (raw, options) => {
        const url = new URL(String(raw));
        if (options?.method === "POST") { posts++; created = remote(JSON.parse(String(options.body))); throw new Error("lost response fixture-secret"); }
        if (url.pathname.endsWith("/remote-1")) return json(created);
        pages++; assert.equal(url.searchParams.get("showHidden"), "true"); assert.equal(url.searchParams.get("showDeleted"), "true");
        assert.equal(url.searchParams.get("showCompleted"), "true");
        return json(url.searchParams.has("pageToken") ? { items: [created!] } : { items: [], nextPageToken: "next" });
      });
      const dispatcher = new GoogleTasksDispatcher(f.service, client, { enabled: true });
      assert.equal(await dispatcher.dispatchOne(), "unknown");
      f.legacy.updateTask({ id: task.id, expectedRevision: 1, sourceSystem: "test", idempotencyKey: "edit", changes: { title: "Newer local task" } });
      assert.equal(await dispatcher.dispatchOne(), "idle");
      assert.equal(await dispatcher.reconcileUnknown(task.id), "synced");
      assert.equal(pages, 2); assert.equal(posts, 1);
      assert.equal(f.service.list()[0]?.title, "Newer local task");
      assert.equal(f.service.list()[0]?.syncState, "queued");
      assert.equal(f.service.listSyncIntents()[0]?.state, "synced");
      assert.equal(await dispatcher.reconcileUnknown(task.id), "synced"); assert.equal(pages, 2);
    } finally { f.close(); }
  });

  for (const scenario of ["zero", "duplicate", "modified", "deleted", "readback_changed", "cycle"] as const) {
    it(`quarantines ${scenario} recovery evidence without a second insert or local mutation`, async () => {
      const f = await fixture();
      try {
        const task = f.legacy.createTask(input); let created: GoogleTask; let posts = 0;
        const client = new GoogleTasksClient("dedicated-list", token, async (raw, options) => {
          if (options?.method === "POST") { posts++; created = remote(JSON.parse(String(options.body))); throw new Error("timeout"); }
          if (String(raw).includes("/remote-1?")) return json({ ...created!, title: "Changed during readback" });
          const matched = scenario === "modified" ? { ...created!, title: "Unrelated task" } : scenario === "deleted" ? { ...created!, deleted: true } : created!;
          return json({ items: scenario === "zero" ? [] : scenario === "duplicate" ? [matched, { ...matched, id: "remote-2" }] : [matched],
            ...(scenario === "cycle" ? { nextPageToken: "repeat" } : {}) });
        });
        const dispatcher = new GoogleTasksDispatcher(f.service, client, { enabled: true });
        await dispatcher.dispatchOne();
        const expected = scenario === "zero" || scenario === "cycle" ? "unknown" : "conflict";
        assert.equal(await dispatcher.reconcileUnknown(task.id), expected);
        assert.equal(await dispatcher.dispatchOne(), "idle"); assert.equal(posts, 1);
        assert.equal(f.service.list()[0]?.title, task.title); assert.equal(f.service.list()[0]?.revision, 1);
        assert.equal(f.service.list()[0]?.syncState, expected);
      } finally { f.close(); }
    });
  }

  it("rolls back mapping and acknowledgement together when the local acknowledgement fails", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input);
      f.db.exec("CREATE TRIGGER fail_google_ack BEFORE UPDATE OF state ON jarvis_task_outbox WHEN NEW.state='synced' BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END;");
      const client = new GoogleTasksClient("dedicated-list", token, async (_url, options) => json(remote(JSON.parse(String(options?.body)))));
      assert.equal(await new GoogleTasksDispatcher(f.service, client, { enabled: true }).dispatchOne(), "unknown");
      assert.equal(f.service.getGoogleTaskProjection(task.id)?.remoteId, null);
      assert.equal(f.service.listSyncIntents()[0]?.state, "unknown");
    } finally { f.close(); }
  });

  it("rejects foreign owners and changing a persisted dedicated list without touching Google", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input); let calls = 0;
      const client = new GoogleTasksClient("list-a", token, async (_url, options) => { calls++; return json(remote(JSON.parse(String(options?.body)))); });
      await new GoogleTasksDispatcher(f.service, client, { enabled: true }).dispatchOne();
      const other = new TaskService(f.db, "silvia");
      assert.throws(() => other.getGoogleTaskProjection(task.id), /owner/i);
      f.legacy.createTask({ ...input, legacyId: "message-2" });
      const changed = new GoogleTasksClient("list-b", token, async () => { calls++; throw new Error("must not send"); });
      await assert.rejects(() => new GoogleTasksDispatcher(f.service, changed, { enabled: true }).dispatchOne(), /list/i);
      assert.equal(calls, 1);
    } finally { f.close(); }
  });
  it("does not allow two owners to bind the same list or acknowledge unknown effects without scan evidence", async () => {
    const f = await fixture();
    try {
      const task = f.legacy.createTask(input);
      const claim = f.service.claimGoogleTaskInsert("dedicated-list")!;
      const request = { title: input.title, notes: claim.projection.marker, status: "needsAction" };
      const prepared = f.service.prepareGoogleTaskRequest(claim, request);
      f.service.markInterruptedSyncUnknown();
      assert.throws(() => f.service.settleGoogleTaskInsert(prepared, { outcome: "synced", requestHash: prepared.projection.requestHash,
        proof: { kind: "insert_ack", matches: 1, pages: 0 }, remote: remote(request) }), /evidence/i);
      assert.throws(() => f.service.settleGoogleTaskInsert(prepared, { outcome: "synced", requestHash: "different",
        proof: { kind: "complete_scan", matches: 1, pages: 1 }, remote: remote(request) }), /payload/i);
      const other = new TaskService(f.db, "silvia");
      assert.throws(() => other.claimGoogleTaskInsert("dedicated-list"), /list/i);
      assert.equal(f.service.listSyncIntents()[0]?.state, "unknown");
      assert.equal(f.service.getGoogleTaskProjection(task.id)?.remoteId, null);
    } finally { f.close(); }
  });
});

describe("Google Tasks HTTP boundary", () => {
  it("accepts bounded provider fractional seconds without losing precision or widening local timestamps", async () => {
    const client = new GoogleTasksClient("list-a", token, async () => json({ ...remote({ title: "Task" }),
      updated: "2026-09-09t17:00:00.123456+02:00", completed: "2026-09-09T15:00:00.987654321Z", due: "2026-09-09T00:00:00.000000Z" }));
    const task = await client.get("remote-1");
    assert.equal(task.updated, "2026-09-09T15:00:00.123456Z");
    assert.equal(task.completed, "2026-09-09T15:00:00.987654321Z");
    assert.equal(task.due, "2026-09-09T00:00:00.000Z");
    assert.throws(() => canonicalInstant("2026-09-09T15:00:00.123456Z", "local timestamp"), /ISO/i);
    const excessive = new GoogleTasksClient("list-a", token, async () => json({ ...remote({}), updated: `2026-09-09T15:00:00.${"1".repeat(31)}Z` }));
    await assert.rejects(() => excessive.get("remote-1"), /invalid_response/i);
  });
  it("retains only the bounded projection fields from untrusted remote objects", async () => {
    const client = new GoogleTasksClient("list-a", token, async () => json({ ...remote({ title: "Task" }), unexpectedPrivateData: "do not persist" }));
    assert.equal((await client.get("remote-1")).unexpectedPrivateData, undefined);
  });
  it("rejects list aliases and paths, and redacts auth/provider failures", async () => {
    for (const list of ["", "@default", "../other", "https://evil.test", "list?x=1"]) assert.throws(() => new GoogleTasksClient(list, token), /list/i);
    for (const status of [401, 403, 404, 429, 500]) {
      const client = new GoogleTasksClient("list-a", token, async () => json({ error: "fixture-secret" }, status));
      await assert.rejects(() => client.scan(), (error: Error) => !error.message.includes("fixture-secret") && error.message.includes("Google Tasks"));
    }
  });
  it("bounds provider responses and complete-list scans without following pagination forever", async () => {
    const huge = new GoogleTasksClient("list-a", token, async () => new Response("x", { headers: { "content-length": "99999999" } }));
    await assert.rejects(() => huge.scan(), /limit/i);
    let calls = 0;
    const pages = new GoogleTasksClient("list-a", token, async () => json({ items: [], nextPageToken: String(++calls) }));
    await assert.rejects(() => pages.scan(), /limit/i); assert.equal(calls, 20);
    const chunked = new GoogleTasksClient("list-a", token, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000)); controller.close(); }
    })));
    await assert.rejects(() => chunked.scan(), /limit/i);
  });
});
