import { DatabaseSync } from "node:sqlite";
import { GOOGLE_TASKS_CANARY_LEASE_TTL_MS, TaskService } from "./task-service.js";
import { GoogleTasksClient, GoogleTasksDispatcher } from "./google-tasks.js";
import { GoogleTasksCanaryWorker, createGoogleTasksTokenProvider, parseGoogleTasksCanaryConfig } from "./google-tasks-worker.js";

const config = parseGoogleTasksCanaryConfig(process.env);
if (!config.enabled) {
  process.stdout.write("GOOGLE_TASKS_CANARY_DISABLED\n");
  process.exitCode = 0;
} else {
  const databasePath = process.env.JARVIS_DATABASE_PATH;
  if (!databasePath) throw new Error("JARVIS_DATABASE_PATH is required.");
  const db = new DatabaseSync(databasePath);
  const store = new TaskService(db, process.env.TELEGRAM_OWNER_ID);
  const client = new GoogleTasksClient(config.listId, createGoogleTasksTokenProvider(config));
  let stopping = false;
  let wake: (() => void) | undefined;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; wake?.(); });
  const lease = store.acquireGoogleTasksCanaryLease();
  try {
    store.renewGoogleTasksCanaryLease(lease);
    const interrupted = store.markInterruptedSyncUnknown();
    // Probe uses only list metadata and occurs before the ready marker.
    await client.probe();
    process.stdout.write(`GOOGLE_TASKS_CANARY_READY interrupted_quarantined=${interrupted} budget=1\n`);
    const worker = new GoogleTasksCanaryWorker(store, new GoogleTasksDispatcher(store, client, { enabled: true }), config.listId, lease);
    while (!stopping) {
      await worker.runCycle();
      let remainingMs = config.pollSeconds * 1000;
      // Heartbeats are local SQLite writes only: they neither call Google nor spend the mutation budget.
      while (!stopping && remainingMs > 0) {
        const delayMs = Math.min(remainingMs, GOOGLE_TASKS_CANARY_LEASE_TTL_MS / 3);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = undefined;
        remainingMs -= delayMs;
        if (!stopping) store.renewGoogleTasksCanaryLease(lease);
      }
    }
  } finally {
    store.releaseGoogleTasksCanaryLease(lease);
    db.close();
  }
}
