import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LegacyStore,
  dispatchDueReminders,
  seedVerifiedLegacyRecords,
  validateStudyReport,
} from "../plugins/jarvis-tools/src/legacy.js";

const temporaryDirectories: string[] = [];

async function store(): Promise<LegacyStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-legacy-"));
  temporaryDirectories.push(directory);
  return new LegacyStore(path.join(directory, "jarvis.sqlite"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LegacyStore", () => {
  it("creates tasks idempotently and completes them idempotently", async () => {
    const database = await store();
    try {
      const first = database.createTask({
        title: "Estudiar variables separables",
        subject: "EDO",
        dueAt: "2026-09-06T09:00:00-05:00",
        sourceSystem: "telegram",
        legacyId: "update-100",
      });
      const duplicate = database.createTask({
        title: "Estudiar variables separables",
        subject: "EDO",
        dueAt: "2026-09-06T09:00:00-05:00",
        sourceSystem: "telegram",
        legacyId: "update-100",
      });
      assert.equal(first.id, duplicate.id);
      assert.equal(database.listTasks("pending").length, 1);
      assert.equal(database.completeTask(first.id).status, "completed");
      assert.equal(database.completeTask(first.id).status, "completed");
    } finally {
      database.close();
    }
  });

  it("claims each due reminder only once even when delivery fails", async () => {
    const database = await store();
    try {
      database.createReminder({
        message: "Salir para clase",
        scheduledAt: "2026-09-05T08:00:00-05:00",
        sourceSystem: "telegram",
        legacyId: "update-200",
      });
      let sends = 0;
      let claimedMessage = "";
      await dispatchDueReminders(database, async (reminder) => {
        sends += 1;
        claimedMessage = reminder.message;
        throw new Error("unknown delivery outcome");
      }, "2026-09-05T08:00:01-05:00");
      await dispatchDueReminders(database, async () => { sends += 1; }, "2026-09-05T08:01:00-05:00");
      assert.equal(sends, 1);
      assert.equal(claimedMessage, "Salir para clase");
      assert.equal(database.listReminders()[0]?.status, "review_required");
    } finally {
      database.close();
    }
  });

  it("compares offset timestamps by instant and quarantines interrupted dispatches", async () => {
    const database = await store();
    try {
      database.createReminder({
        message: "Future in Bogota",
        scheduledAt: "2026-09-05T18:00:00-05:00",
        sourceSystem: "telegram",
        legacyId: "future-offset",
      });
      assert.equal(database.claimDueReminders("2026-09-05T20:00:00.000Z").length, 0);
      assert.equal(database.claimDueReminders("2026-09-05T23:00:01.000Z").length, 1);
      assert.equal(database.quarantineInterruptedDispatches(), 1);
      assert.equal(database.listReminders()[0]?.status, "review_required");
    } finally {
      database.close();
    }
  });

  it("seeds only verified legacy records idempotently and quarantines old reminders", async () => {
    const database = await store();
    try {
      seedVerifiedLegacyRecords(database, "2026-09-05T12:00:00-05:00");
      seedVerifiedLegacyRecords(database, "2026-09-05T12:00:00-05:00");
      const task = database.listTasks("all").find(({ id }) => id === 18);
      assert.equal(task?.title, "Preparar quiz de Circuitos hasta el Teorema de Thévenin, sin incluirlo");
      assert.equal(task?.dueDate, "2026-09-10");
      assert.equal(task?.dueAt, null);
      assert.equal(task?.sourceSystem, "legacy-transcript");
      const reminders = database.listReminders();
      assert.equal(reminders.length, 3);
      assert.ok(reminders.every(({ status, scheduledAt }) => status === "review_required" && scheduledAt === null));
      assert.ok(database.listMaterials().every(({ availability }) => availability === "unavailable"));
      assert.equal(database.listHandoffs().length, 4);
    } finally {
      database.close();
    }
  });

  it("keeps material seeding idempotent across restarts when only importedAt changes", async () => {
    const first = await store();
    const databasePath = first.path;
    const material = {
      fileName: "guide.pdf",
      subject: "EDO",
      topic: "Unit I",
      availability: "unavailable" as const,
      sourceSystem: "legacy-transcript",
      legacyId: "material-restart",
    };
    first.recordMaterial({ ...material, importedAt: "2026-09-05T12:00:00-05:00" });
    first.close();

    const restarted = new LegacyStore(databasePath);
    try {
      restarted.recordMaterial({ ...material, importedAt: "2026-09-06T12:00:00-05:00" });
      assert.equal(restarted.listMaterials().length, 1);
      assert.equal(restarted.listMaterials()[0]?.importedAt, "2026-09-05T12:00:00-05:00");
      assert.throws(
        () => restarted.recordMaterial({ ...material, topic: "Unit II", importedAt: "2026-09-06T12:00:00-05:00" }),
        /idempotency key/i,
      );
    } finally {
      restarted.close();
    }
  });

  it("validates and ingests bounded study reports idempotently", async () => {
    const database = await store();
    try {
      seedVerifiedLegacyRecords(database, "2026-09-05T12:00:00-05:00");
      const payload = {
        schemaVersion: "unab-os.study-report.v1",
        handoffId: "6af29b73-89e9-455a-b165-44c6d6a73bc2",
        summary: "Repaso realizado con ejercicios guiados.",
        strengths: [{ topic: "Movimiento armónico", evidence: "Resolvió el primer ejercicio." }],
        weaknesses: [],
        questionsMissed: [],
        confidence: "medium",
        nextActions: [{ action: "Practicar amplitud", minutes: 20 }],
      } as const;
      assert.equal(validateStudyReport(payload).handoffId, payload.handoffId);
      const first = database.ingestStudyReport(payload, "unab-os");
      const duplicate = database.ingestStudyReport(payload, "unab-os");
      assert.equal(first.id, duplicate.id);
      assert.throws(() => validateStudyReport({ ...payload, nextActions: [{ action: "Too long", minutes: 241 }] }));
      assert.throws(() => validateStudyReport({ ...payload, schemaVersion: "unknown" }));
    } finally {
      database.close();
    }
  });

  it("rejects provenance idempotency keys reused for different facts, materials, or handoffs", async () => {
    const database = await store();
    try {
      const provenance = { sourceSystem: "telegram", legacyId: "same-key" };
      database.recordAcademicFact({ subject: "Circuitos", factType: "quiz", value: { date: "2026-09-10" }, ...provenance });
      assert.throws(() => database.recordAcademicFact({ subject: "Circuitos", factType: "quiz", value: { date: "2026-09-11" }, ...provenance }), /idempotency key/i);

      database.recordMaterial({ fileName: "guide.pdf", subject: "EDO", topic: "Unit I", availability: "unavailable", ...provenance });
      assert.throws(() => database.recordMaterial({ fileName: "different.pdf", subject: "EDO", topic: "Unit I", availability: "unavailable", ...provenance }), /idempotency key/i);

      database.recordHandoff({ handoffId: "handoff-1", subject: "EDO", focus: "Unit I", materialLegacyId: null, status: "open", ...provenance });
      assert.throws(() => database.recordHandoff({ handoffId: "handoff-1", subject: "EDO", focus: "Different focus", materialLegacyId: null, status: "open", ...provenance }), /idempotency key/i);
    } finally {
      database.close();
    }
  });
});
