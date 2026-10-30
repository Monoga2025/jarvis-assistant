import { readFile } from "node:fs/promises";
import { LegacyStore, dispatchDueReminders } from "./legacy.js";
import {
  NotificationStore,
  buildNotificationPresentation,
  sendTelegramPresentation,
  type NotificationActionRecord,
} from "./notifications.js";

const databasePath = process.env.JARVIS_DATABASE_PATH;
const ownerId = process.env.TELEGRAM_OWNER_ID;
const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE ?? "/data/jarvis-v1/credentials/telegram-bot-token";
const pollSeconds = Number(process.env.REMINDER_POLL_SECONDS ?? "60");
if (!databasePath) throw new Error("JARVIS_DATABASE_PATH is required.");
if (!ownerId || !/^[1-9][0-9]{5,19}$/.test(ownerId)) throw new Error("TELEGRAM_OWNER_ID is invalid.");
if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new Error("REMINDER_POLL_SECONDS must be between 5 and 3600.");

const token = (await readFile(tokenFile, "utf8")).trim();
if (!token) throw new Error("Telegram token file is empty.");
const telegramOwnerId = ownerId;
const store = new LegacyStore(databasePath);
const interrupted = store.quarantineInterruptedDispatches();
const notifications = new NotificationStore(databasePath);
const interruptedUrgent = notifications.quarantineInterruptedUrgentAlerts();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; });

async function send(action: NotificationActionRecord): Promise<void> {
  await sendTelegramPresentation(
    fetch,
    `https://api.telegram.org/bot${token}/sendMessage`,
    telegramOwnerId,
    buildNotificationPresentation(action),
  );
}

try {
  process.stdout.write(`REMINDER_WORKER_READY interrupted_quarantined=${interrupted} urgent_interrupted_quarantined=${interruptedUrgent}\n`);
  while (!stopping) {
    const result = await dispatchDueReminders(store, async (reminder) => {
      const action = notifications.createReminderAction(reminder, telegramOwnerId, new Date().toISOString());
      await send(action);
    });
    if (result.sent > 0 || result.reviewRequired > 0) {
      process.stdout.write(`REMINDER_DISPATCH_RESULT sent=${result.sent} review_required=${result.reviewRequired}\n`);
    }
    const claimed = notifications.claimUrgentTask(new Date().toISOString(), telegramOwnerId);
    if (claimed) {
      try {
        await send(claimed);
        const sentAt = new Date().toISOString();
        notifications.markUrgentSent(claimed.task.id, claimed.dueInstance, sentAt);
        process.stdout.write("URGENT_DISPATCH_RESULT sent=1 review_required=0\n");
      } catch {
        notifications.markUrgentReviewRequired(claimed.task.id, claimed.dueInstance);
        process.stdout.write("URGENT_DISPATCH_RESULT sent=0 review_required=1\n");
      }
    }
    const routine = notifications.claimRoutineAlert(new Date().toISOString(), telegramOwnerId);
    if (routine) {
      try {
        await send(routine);
        process.stdout.write(`ROUTINE_DISPATCH_RESULT type=${routine.routineType} sent=1\n`);
      } catch {
        process.stdout.write(`ROUTINE_DISPATCH_RESULT type=${routine.routineType} sent=0 error=1\n`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
} finally {
  notifications.close();
  store.close();
}
