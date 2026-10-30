import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { LegacyStore } from "../plugins/jarvis-tools/src/legacy.js";
import { GOOGLE_TASKS_CANARY_LEASE_TTL_MS, TaskService } from "../plugins/jarvis-tools/src/task-service.js";
import { GoogleTasksCanaryWorker, parseGoogleTasksCanaryConfig } from "../plugins/jarvis-tools/src/google-tasks-worker.js";

describe("Google Tasks canary configuration", () => {
  it("is disabled by default without inspecting credentials", () => {
    assert.deepEqual(parseGoogleTasksCanaryConfig({}), { enabled: false });
  });

  it("fails closed before startup unless every enabled literal is present and bounded", () => {
    assert.throws(() => parseGoogleTasksCanaryConfig({ JARVIS_GOOGLE_TASKS_ENABLED: "true" }), /CALENDAR/i);
    assert.throws(() => parseGoogleTasksCanaryConfig({ JARVIS_GOOGLE_TASKS_ENABLED: "true", JARVIS_CALENDAR_ENABLED: "true", GOOGLE_TASKS_LIST_ID: "list", JARVIS_GOOGLE_TASKS_CANARY_MODE: "single_insert", JARVIS_GOOGLE_TASKS_POLL_SECONDS: "4" }), /POLL/i);
    assert.deepEqual(parseGoogleTasksCanaryConfig({
      JARVIS_GOOGLE_TASKS_ENABLED: "true", JARVIS_CALENDAR_ENABLED: "true", GOOGLE_TASKS_LIST_ID: "dedicated-list",
      JARVIS_GOOGLE_TASKS_CANARY_MODE: "single_insert", JARVIS_GOOGLE_TASKS_POLL_SECONDS: "60",
      GOOGLE_CLIENT_ID_FILE: "/safe/id", GOOGLE_CLIENT_SECRET_FILE: "/safe/secret", GOOGLE_REFRESH_TOKEN_FILE: "/safe/token",
    }), { enabled: true, listId: "dedicated-list", pollSeconds: 60, credentialFiles: { clientId: "/safe/id", clientSecret: "/safe/secret", refreshToken: "/safe/token" } });
  });

  it("spends exactly one process-lifetime budget on unknown recovery and never on idle", async () => {
    const unknown = { taskId: 7, state: "unknown" };
    const store = {
      listSyncIntents: () => [unknown],
      getGoogleTaskClaim: () => ({ projection: { listId: "dedicated-list" } }),
      assertGoogleTasksCanaryLease: () => {},
      renewGoogleTasksCanaryLease: () => {},
    };
    let recoveries = 0;
    const dispatcher = {
      reconcileUnknown: async () => { recoveries += 1; return "unknown" as const; },
      dispatchOne: async () => { throw new Error("must not insert after recovery"); },
    };
    const worker = new GoogleTasksCanaryWorker(store as never, dispatcher as never, "dedicated-list", "lease", () => {});
    assert.equal(await worker.runCycle(), "unknown");
    assert.equal(await worker.runCycle(), "budget_exhausted");
    assert.equal(recoveries, 1);

    const idleStore = { listSyncIntents: () => [], getGoogleTaskClaim: () => null, assertGoogleTasksCanaryLease: () => {}, renewGoogleTasksCanaryLease: () => {} };
    const idleWorker = new GoogleTasksCanaryWorker(idleStore as never, dispatcher as never, "dedicated-list", "lease", () => {});
    assert.equal(await idleWorker.runCycle(), "idle");
    assert.equal(await idleWorker.runCycle(), "idle");
  });

  it("reclaims an expired crash lease but never a live holder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-canary-lease-"));
    const file = path.join(root, "tasks.sqlite");
    const legacy = new LegacyStore(file);
    const firstDb = new DatabaseSync(file), first = new TaskService(firstDb);
    const start = 1_700_000_000_000;
    const firstLease = first.acquireGoogleTasksCanaryLease(start);
    const secondDb = new DatabaseSync(file), second = new TaskService(secondDb);
    try {
      first.renewGoogleTasksCanaryLease(firstLease, start + GOOGLE_TASKS_CANARY_LEASE_TTL_MS);
      assert.throws(() => second.acquireGoogleTasksCanaryLease(start + (GOOGLE_TASKS_CANARY_LEASE_TTL_MS * 2)), /held/i);
      firstDb.close(); // simulate abnormal process termination: no release
      const reclaimed = second.acquireGoogleTasksCanaryLease(start + (GOOGLE_TASKS_CANARY_LEASE_TTL_MS * 2) + 1);
      assert.throws(() => second.assertGoogleTasksCanaryLease(firstLease), /unavailable/i);
      second.assertGoogleTasksCanaryLease(reclaimed);
      second.releaseGoogleTasksCanaryLease(reclaimed);
    } finally {
      try { firstDb.close(); } catch { /* already closed by crash simulation */ }
      secondDb.close(); legacy.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects lease contention before provider work", async () => {
    let providerCalls = 0;
    const store = {
      assertGoogleTasksCanaryLease: () => { throw new Error("lease is unavailable"); },
      renewGoogleTasksCanaryLease: () => { throw new Error("lease is unavailable"); },
      listSyncIntents: () => [{ taskId: 9, state: "queued" }],
      getGoogleTaskClaim: () => null,
    };
    const dispatcher = { reconcileUnknown: async () => "unknown" as const, dispatchOne: async () => { providerCalls += 1; return "synced" as const; } };
    const worker = new GoogleTasksCanaryWorker(store as never, dispatcher as never, "dedicated-list", "stale-lease", () => {});
    await assert.rejects(() => worker.runCycle(), /lease/i);
    assert.equal(providerCalls, 0);
  });

  it("spends the sole budget on a queued insert", async () => {
    const store = { listSyncIntents: () => [{ taskId: 9, state: "queued" }], getGoogleTaskClaim: () => null, assertGoogleTasksCanaryLease: () => {}, renewGoogleTasksCanaryLease: () => {} };
    let inserts = 0;
    const dispatcher = { reconcileUnknown: async () => "unknown" as const, dispatchOne: async () => { inserts += 1; return "synced" as const; } };
    const worker = new GoogleTasksCanaryWorker(store as never, dispatcher as never, "dedicated-list", "lease", () => {});
    assert.equal(await worker.runCycle(), "synced");
    assert.equal(await worker.runCycle(), "budget_exhausted");
    assert.equal(inserts, 1);
  });
});
