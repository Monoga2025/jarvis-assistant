import { LegacyStore, seedVerifiedLegacyRecords } from "./legacy.js";

const databasePath = process.env.JARVIS_DATABASE_PATH;
if (!databasePath) throw new Error("JARVIS_DATABASE_PATH is required.");
const store = new LegacyStore(databasePath);
try {
  seedVerifiedLegacyRecords(store);
  process.stdout.write(`LEGACY_SEED_READY tasks=${store.listTasks("all").length} reminders=${store.listReminders().length}\n`);
} finally {
  store.close();
}
