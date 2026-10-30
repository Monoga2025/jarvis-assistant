import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LegacyStore } from "../plugins/jarvis-tools/src/legacy.js";
import { AssistantModeStore } from "../plugins/jarvis-tools/src/assistant-mode.js";
import {
  NotificationStore,
  buildNotificationPresentation,
  escapeTelegramHtml,
  handleJarvisCallback,
  sendTelegramPresentation,
} from "../plugins/jarvis-tools/src/notifications.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-notifications-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "jarvis.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("urgent notification policy", () => {
  it("claims one upcoming task permanently across restart and ambiguous delivery", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "Entregar <taller>", subject: "EDO", dueAt: "2026-09-10T10:00:00-05:00", sourceSystem: "test", legacyId: "urgent-1" });
    legacy.close();

    const first = new NotificationStore(file);
    const claim = first.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789");
    assert.equal(claim?.task.title, "Entregar <taller>");
    first.close();

    const restarted = new NotificationStore(file);
    assert.equal(restarted.quarantineInterruptedUrgentAlerts(), 1);
    assert.equal(restarted.claimUrgentTask("2026-09-09T12:10:00-05:00", "123456789"), null);
    restarted.close();
  });

  it("never nags overdue tasks and labels date-only deadlines with unknown time", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "Overdue", subject: "EDO", dueAt: "2026-09-09T11:59:00-05:00", sourceSystem: "test", legacyId: "overdue" });
    legacy.createTask({ title: "Today", subject: "Circuitos", dueDate: "2026-09-09", sourceSystem: "test", legacyId: "today" });
    legacy.createTask({ title: "Tomorrow date only", subject: "Física", dueDate: "2026-09-10", sourceSystem: "test", legacyId: "tomorrow" });
    legacy.close();

    const notifications = new NotificationStore(file);
    const claim = notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789");
    assert.equal(claim?.task.title, "Today");
    assert.equal(claim?.dateOnly, true);
    assert.match(buildNotificationPresentation(claim!).html, /hora.*no está definida/i);
    notifications.close();
  });

  it("allows at most one normal-mode proactive urgent alert in any 24 hours", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "First", subject: "EDO", dueAt: "2026-09-09T13:00:00-05:00", sourceSystem: "test", legacyId: "first" });
    legacy.createTask({ title: "Second", subject: "EDO", dueAt: "2026-09-09T14:00:00-05:00", sourceSystem: "test", legacyId: "second" });
    legacy.close();

    const notifications = new NotificationStore(file);
    const first = notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789");
    assert.ok(first);
    notifications.markUrgentSent(first!.task.id, first!.dueInstance, "2026-09-09T12:00:01-05:00");
    assert.equal(notifications.claimUrgentTask("2026-09-10T11:59:59-05:00", "123456789"), null);
    notifications.close();
  });

  it("stays silent while explicit work mode is active", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "Upcoming", subject: "EDO", dueAt: "2026-09-09T13:00:00-05:00", sourceSystem: "test", legacyId: "work-silent" });
    legacy.close();
    const mode = new AssistantModeStore(file, () => new Date("2026-09-09T12:00:00-05:00"));
    mode.set({ mode: "work", goal: "Terminar EDO", sourceSystem: "test", idempotencyKey: "work" });
    mode.close();
    const notifications = new NotificationStore(file);
    assert.equal(notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789"), null);
    notifications.close();
  });
});

describe("Telegram notification presentation", () => {
  it("rejects a stale Done token after the task was edited instead of completing the newer revision", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    const task = legacy.createTask({ title: "Original", subject: "X", dueDate: "2026-09-09", sourceSystem: "test", legacyId: "stale" });
    const notifications = new NotificationStore(file);
    const claim = notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789")!;
    notifications.close();
    legacy.updateTask({ id: task.id, expectedRevision: 1, sourceSystem: "test", idempotencyKey: "edit", changes: { title: "Revised work" } });
    legacy.close();
    const edits: string[] = [];
    await handleJarvisCallback({ senderId: "123456789", isGroup: false, auth: { isAuthorizedSender: true },
      callback: { payload: `n:${claim.token}:d`, chatId: "123456789" },
      respond: { editMessage: async ({ text }: { text: string }) => { edits.push(text); }, clearButtons: async () => {} },
    }, { databasePath: file, ownerId: "123456789" });
    const verify = new LegacyStore(file);
    try {
      assert.equal(verify.listTasks("all")[0]?.status, "pending");
      assert.equal(verify.listTasks("all")[0]?.revision, 2);
      assert.match(edits[0] ?? "", /versión|pendientes/i);
      assert.equal(verify.listTaskSyncIntents().length, 2);
    } finally { verify.close(); }
  });

  it("adds a nullable revision binding and refuses legacy Done tokens that lack one", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    const task = legacy.createTask({ title: "Legacy button", subject: "X", sourceSystem: "test", legacyId: "unbound" });
    legacy.close();
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE jarvis_notification_actions(token TEXT PRIMARY KEY,source_kind TEXT NOT NULL,source_id INTEGER NOT NULL,
      source_instance TEXT NOT NULL,owner_id TEXT NOT NULL,label TEXT NOT NULL,date_only INTEGER NOT NULL,due_at TEXT,status TEXT NOT NULL,
      created_at TEXT NOT NULL,consumed_at TEXT,consumed_action TEXT,UNIQUE(source_kind,source_id,source_instance));`);
    raw.prepare("INSERT INTO jarvis_notification_actions VALUES('abcdefghijklmnop','urgent',?,'old','123456789','Legacy button',1,NULL,'pending','2026-09-09',NULL,NULL)").run(task.id);
    raw.close();
    await handleJarvisCallback({ senderId: "123456789", isGroup: false, auth: { isAuthorizedSender: true },
      callback: { payload: "n:abcdefghijklmnop:d", chatId: "123456789" },
      respond: { editMessage: async () => {}, clearButtons: async () => {} },
    }, { databasePath: file, ownerId: "123456789" });
    const verify = new LegacyStore(file);
    try { assert.equal(verify.listTasks("all")[0]?.status, "pending"); assert.equal(verify.listTasks("all")[0]?.revision, 1); }
    finally { verify.close(); }
  });

  it("replays the callback's durable completion intent after a crash before action consumption", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "One completion", subject: "X", dueDate: "2026-09-09", sourceSystem: "test", legacyId: "crash" });
    legacy.close();
    const notifications = new NotificationStore(file);
    const claim = notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789")!;
    notifications.close();
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TRIGGER fail_consumption BEFORE UPDATE ON jarvis_notification_actions BEGIN SELECT RAISE(ABORT,'consume interrupted'); END;");
    const context = { senderId: "123456789", isGroup: false, auth: { isAuthorizedSender: true },
      callback: { payload: `n:${claim.token}:d`, chatId: "123456789" }, respond: { editMessage: async () => {}, clearButtons: async () => {} } };
    try {
      await assert.rejects(handleJarvisCallback(context, { databasePath: file, ownerId: "123456789" }), /consume interrupted/);
      assert.ok(raw.prepare("SELECT 1 FROM jarvis_task_intents WHERE intent_key=?").get(`notification:${claim.token}:done`));
      raw.exec("DROP TRIGGER fail_consumption;");
      await handleJarvisCallback(context, { databasePath: file, ownerId: "123456789" });
      assert.equal(raw.prepare("SELECT revision FROM jarvis_task_metadata").get()?.revision, 2);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM jarvis_task_outbox").get()?.count, 2);
      assert.equal(raw.prepare("SELECT status FROM jarvis_notification_actions").get()?.status, "consumed");
    } finally { raw.close(); }
  });
  it("escapes HTML and keeps opaque callback data within Telegram's limit", async () => {
    assert.equal(escapeTelegramHtml('A&B <C> "D"'), "A&amp;B &lt;C&gt; &quot;D&quot;");
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    const reminder = legacy.createReminder({ message: "Leer <capítulo> & responder", scheduledAt: "2026-09-09T12:00:00-05:00", sourceSystem: "test", legacyId: "reminder" });
    legacy.close();
    const notifications = new NotificationStore(file);
    const action = notifications.createReminderAction(reminder, "123456789", "2026-09-09T12:00:00-05:00");
    const presentation = buildNotificationPresentation(action);
    assert.match(presentation.html, /&lt;capítulo&gt; &amp; responder/);
    assert.ok(presentation.buttons.flat().every(({ callback_data }) => callback_data.length <= 64 && /^jarvis:n:[A-Za-z0-9_-]+:[dwl]$/.test(callback_data)));
    notifications.close();
  });

  it("rechecks owner authorization and consumes callbacks idempotently", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    legacy.createTask({ title: "Ship", subject: "Project", dueAt: "2026-09-09T13:00:00-05:00", sourceSystem: "test", legacyId: "ship" });
    legacy.close();
    const notifications = new NotificationStore(file);
    const claim = notifications.claimUrgentTask("2026-09-09T12:00:00-05:00", "123456789")!;
    notifications.close();
    const payload = `n:${claim.token}:d`;
    const edits: string[] = [];
    const context = {
      senderId: "123456789",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload, chatId: "123456789" },
      respond: { editMessage: async ({ text }: { text: string }) => { edits.push(text); }, clearButtons: async () => {} },
    };
    assert.equal((await handleJarvisCallback(context, { databasePath: file, ownerId: "123456789" })).handled, true);
    assert.equal((await handleJarvisCallback(context, { databasePath: file, ownerId: "123456789" })).handled, true);
    const verify = new LegacyStore(file);
    assert.equal(verify.listTasks("all")[0]?.status, "completed");
    verify.close();
    assert.equal(edits.length, 2);

    const unauthorized = { ...context, senderId: "987654321", auth: { isAuthorizedSender: false } };
    assert.equal((await handleJarvisCallback(unauthorized, { databasePath: file, ownerId: "123456789" })).handled, true);
  });

  it("falls back to plain text only after a definitive Telegram validation rejection", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return bodies.length === 1
        ? { ok: false, status: 400, json: async () => ({ ok: false }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    await sendTelegramPresentation(fetcher, "https://telegram.invalid/send", "123456789", {
      html: "<b>Safe</b>",
      plainText: "Safe",
      buttons: [[{ text: "Done", callback_data: "jarvis:n:abcdefghijklmnop:d" }]],
    });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.parse_mode, "HTML");
    assert.ok(bodies[0]?.reply_markup);
    assert.equal(bodies[1]?.text, "Safe");
    assert.equal(bodies[1]?.parse_mode, undefined);
    assert.equal(bodies[1]?.reply_markup, undefined);

    let ambiguousAttempts = 0;
    await assert.rejects(() => sendTelegramPresentation(async () => {
      ambiguousAttempts += 1;
      throw new Error("network outcome unknown");
    }, "https://telegram.invalid/send", "123456789", {
      html: "<b>Safe</b>",
      plainText: "Safe",
      buttons: [],
    }));
    assert.equal(ambiguousAttempts, 1);
  });

  it("applies work-mode and remind-later actions idempotently", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    const workReminder = legacy.createReminder({ message: "Terminar EDO", scheduledAt: "2026-09-09T12:00:00-05:00", sourceSystem: "test", legacyId: "work-action" });
    const laterReminder = legacy.createReminder({ message: "Tomar agua", scheduledAt: "2026-09-09T12:01:00-05:00", sourceSystem: "test", legacyId: "later-action" });
    legacy.close();
    const notifications = new NotificationStore(file);
    const work = notifications.createReminderAction(workReminder, "123456789", "2026-09-09T12:00:00-05:00");
    const later = notifications.createReminderAction(laterReminder, "123456789", "2026-09-09T12:01:00-05:00");
    notifications.close();
    const edits: string[] = [];
    const base = {
      senderId: "123456789",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload: "", chatId: "123456789" },
      respond: { editMessage: async ({ text }: { text: string }) => { edits.push(text); }, clearButtons: async () => {} },
    };
    const deps = { databasePath: file, ownerId: "123456789", now: () => new Date("2026-09-09T12:10:00-05:00") };
    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${work.token}:w` } }, deps);
    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${work.token}:w` } }, deps);
    const mode = new AssistantModeStore(file);
    assert.deepEqual({ mode: mode.get().mode, goal: mode.get().goal }, { mode: "work", goal: "Terminar EDO" });
    mode.close();

    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${later.token}:l` } }, deps);
    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${later.token}:l` } }, deps);
    const verify = new LegacyStore(file);
    const deferred = verify.listReminders().filter(({ sourceSystem }) => sourceSystem === "jarvis-notification");
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0]?.scheduledAt, "2026-09-09T18:10:00.000Z");
    verify.close();
    assert.equal(edits.length, 4);
  });

  it("claims morning briefing and evening closeout within their exact time windows once per day", async () => {
    const file = await databasePath();
    const notifications = new NotificationStore(file);

    // 05:00 AM Bogotá -> too early for morning
    assert.equal(notifications.claimRoutineAlert("2026-09-09T05:00:00-05:00", "123456789"), null);

    // 07:30 AM Bogotá -> within morning window (06:30 - 11:00)
    const morning = notifications.claimRoutineAlert("2026-09-09T07:30:00-05:00", "123456789");
    assert.ok(morning);
    assert.equal(morning.routineType, "morning");
    assert.equal(morning.sourceInstance, "morning:2026-09-09");
    assert.match(morning.label, /Buenos días/i);

    // Repeated morning call on same day returns null (idempotent 1-per-day)
    assert.equal(notifications.claimRoutineAlert("2026-09-09T08:00:00-05:00", "123456789"), null);

    // 14:00 PM Bogotá -> mid-day, outside windows
    assert.equal(notifications.claimRoutineAlert("2026-09-09T14:00:00-05:00", "123456789"), null);

    // 22:00 PM Bogotá -> within night window (21:30 - 23:59)
    const night = notifications.claimRoutineAlert("2026-09-09T22:00:00-05:00", "123456789");
    assert.ok(night);
    assert.equal(night.routineType, "night");
    assert.equal(night.sourceInstance, "night:2026-09-09");
    assert.match(night.label, /Cierre de jornada/i);

    // Repeated night call on same day returns null
    assert.equal(notifications.claimRoutineAlert("2026-09-09T22:30:00-05:00", "123456789"), null);

    notifications.close();
  });

  it("presents morning and evening routines with dedicated buttons and confirms day close upon done callback", async () => {
    const file = await databasePath();
    const notifications = new NotificationStore(file);
    const morning = notifications.claimRoutineAlert("2026-09-09T08:00:00-05:00", "123456789")!;
    const night = notifications.claimRoutineAlert("2026-09-09T22:00:00-05:00", "123456789")!;
    notifications.close();

    const morningPres = buildNotificationPresentation(morning);
    assert.match(morningPres.html, /Buenos días/i);
    assert.equal(morningPres.buttons[0]?.[0]?.text, "✅ Iniciar día");
    assert.equal(morningPres.buttons[0]?.[1]?.text, "🎯 Modo trabajo");

    const nightPres = buildNotificationPresentation(night);
    assert.match(nightPres.html, /Cierre de jornada/i);
    assert.equal(nightPres.buttons[0]?.[0]?.text, "✅ Confirmar cierre");

    const edits: string[] = [];
    const base = {
      senderId: "123456789",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload: "", chatId: "123456789" },
      respond: { editMessage: async ({ text }: { text: string }) => { edits.push(text); }, clearButtons: async () => {} },
    };
    const deps = { databasePath: file, ownerId: "123456789", now: () => new Date("2026-09-09T22:05:00-05:00") };

    // Dispatches night done callback
    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${night.token}:d` } }, deps);
    assert.match(edits[0]!, /cierre diario registrado/i);

    // Check that CoachingStore has recorded the day close
    const { CoachingStore } = await import("../plugins/jarvis-tools/src/coaching.js");
    const coaching = new CoachingStore(file);
    const summary = coaching.summary("2026-09-09T22:10:00-05:00");
    // Daily close is complete!
    assert.notEqual(summary.reward.reason, "daily_close_incomplete");
    coaching.close();
  });

  it("presents focus timer notifications with interactive study completion and break scheduling", async () => {
    const file = await databasePath();
    const legacy = new LegacyStore(file);
    const focusReminder = legacy.createReminder({
      message: "🎯 Fin de bloque de foco (45m): Taller de EDO",
      scheduledAt: "2026-09-09T14:45:00-05:00",
      sourceSystem: "jarvis-focus-timer",
      legacyId: "focus:taller-edo",
    });
    legacy.close();

    const notifications = new NotificationStore(file);
    const action = notifications.createReminderAction(focusReminder, "123456789", "2026-09-09T14:45:00-05:00");
    notifications.close();

    const pres = buildNotificationPresentation(action);
    assert.match(pres.html, /Tiempo cumplido de foco \(45 min\)/i);
    assert.match(pres.html, /Taller de EDO/i);
    assert.equal(pres.buttons[0]?.[0]?.text, "✅ Bloque completado");
    assert.equal(pres.buttons[0]?.[1]?.text, "⏳ 15m más");
    assert.equal(pres.buttons[0]?.[2]?.text, "🛋️ Terminar sesión");

    const edits: string[] = [];
    const base = {
      senderId: "123456789",
      isGroup: false,
      auth: { isAuthorizedSender: true },
      callback: { payload: "", chatId: "123456789" },
      respond: { editMessage: async ({ text }: { text: string }) => { edits.push(text); }, clearButtons: async () => {} },
    };
    const deps = { databasePath: file, ownerId: "123456789", now: () => new Date("2026-09-09T14:45:05-05:00") };

    // Dispatches focus done callback
    await handleJarvisCallback({ ...base, callback: { ...base.callback, payload: `n:${action.token}:d` } }, deps);
    assert.match(edits[0]!, /bloque.*completado/i);

    // Verify study check-in in CoachingStore
    const { CoachingStore } = await import("../plugins/jarvis-tools/src/coaching.js");
    const coaching = new CoachingStore(file);
    const summary = coaching.summary("2026-09-09T14:45:10-05:00");
    assert.equal(summary.consistency.study.currentWeek, 1);
    coaching.close();

    // Verify break reminder was scheduled for 10 minutes later
    const verifyStore = new LegacyStore(file);
    const reminders = verifyStore.listReminders();
    const breakReminder = reminders.find((r) => r.sourceSystem === "jarvis-focus-break");
    assert.ok(breakReminder);
    assert.match(breakReminder!.message, /Pausa de 10 minutos/i);
    verifyStore.close();
  });
});
