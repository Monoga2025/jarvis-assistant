import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TaskService, type JarvisTask, type TaskCreateInput, type TaskStatus, type TaskUpdateInput, type TaskSyncIntent, type TaskSyncSettlement } from "./task-service.js";
export type { JarvisTask, TaskStatus } from "./task-service.js";

export type ReminderStatus = "scheduled" | "dispatching" | "sent" | "review_required" | "cancelled";

interface ProvenanceInput {
  sourceSystem: string;
  legacyId?: string;
  sourceHash?: string;
  importedAt?: string;
}

export interface JarvisReminder {
  id: number;
  message: string;
  scheduledAt: string | null;
  status: ReminderStatus;
  pausedReason: string | null;
  claimedAt: string | null;
  sentAt: string | null;
  sourceSystem: string;
  legacyId: string;
  sourceHash: string;
  importedAt: string;
}

export interface StudyMaterial {
  id: number;
  fileName: string;
  subject: string;
  topic: string;
  availability: "unavailable" | "metadata_only";
  sourceSystem: string;
  legacyId: string;
  sourceHash: string;
  importedAt: string;
}

export interface StudyHandoff {
  handoffId: string;
  subject: string;
  focus: string;
  materialLegacyId: string | null;
  status: "legacy_reference" | "open" | "reported";
  sourceSystem: string;
  legacyId: string;
  sourceHash: string;
  importedAt: string;
}

export interface StudyReport {
  schemaVersion: "unab-os.study-report.v1";
  handoffId: string;
  summary: string;
  strengths: Array<{ topic: string; evidence: string }>;
  weaknesses: Array<{ topic: string; evidence: string }>;
  questionsMissed: Array<{ question: string; reason: string }>;
  confidence: "low" | "medium" | "high";
  nextActions: Array<{ action: string; minutes: number }>;
}

interface SqlReminderRow {
  id: number;
  message: string;
  scheduled_at: string | null;
  status: ReminderStatus;
  paused_reason: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  source_system: string;
  legacy_id: string;
  source_hash: string;
  imported_at: string;
}

interface SqlMaterialRow {
  id: number;
  file_name: string;
  subject: string;
  topic: string;
  availability: "unavailable" | "metadata_only";
  source_system: string;
  legacy_id: string;
  source_hash: string;
  imported_at: string;
}

interface SqlHandoffRow {
  handoff_id: string;
  subject: string;
  focus: string;
  material_legacy_id: string | null;
  status: "legacy_reference" | "open" | "reported";
  source_system: string;
  legacy_id: string;
  source_hash: string;
  imported_at: string;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function provenance(input: ProvenanceInput, content: unknown): Required<ProvenanceInput> {
  return {
    sourceSystem: input.sourceSystem,
    legacyId: input.legacyId ?? randomUUID(),
    sourceHash: input.sourceHash ?? canonicalHash(content),
    importedAt: input.importedAt ?? new Date().toISOString(),
  };
}

function reminderFromRow(row: SqlReminderRow): JarvisReminder {
  return {
    id: row.id,
    message: row.message,
    scheduledAt: row.scheduled_at,
    status: row.status,
    pausedReason: row.paused_reason,
    claimedAt: row.claimed_at,
    sentAt: row.sent_at,
    sourceSystem: row.source_system,
    legacyId: row.legacy_id,
    sourceHash: row.source_hash,
    importedAt: row.imported_at,
  };
}

export class LegacyStore {
  private readonly database: DatabaseSync;
  private readonly tasks: TaskService;

  constructor(public readonly path: string, options?: { ownerId: string }) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jarvis_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        due_date TEXT,
        due_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','completed')),
        completed_at TEXT,
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
      CREATE TABLE IF NOT EXISTS jarvis_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        scheduled_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('scheduled','dispatching','sent','review_required','cancelled')),
        paused_reason TEXT,
        claimed_at TEXT,
        sent_at TEXT,
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
      CREATE INDEX IF NOT EXISTS jarvis_reminders_due ON jarvis_reminders(status, scheduled_at);
      CREATE TABLE IF NOT EXISTS jarvis_academic_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        fact_type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        effective_date TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','review_required')),
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
      CREATE TABLE IF NOT EXISTS jarvis_study_materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT NOT NULL,
        subject TEXT NOT NULL,
        topic TEXT NOT NULL,
        availability TEXT NOT NULL CHECK(availability IN ('unavailable','metadata_only')),
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
      CREATE TABLE IF NOT EXISTS jarvis_study_handoffs (
        handoff_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        focus TEXT NOT NULL,
        material_legacy_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('legacy_reference','open','reported')),
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
      CREATE TABLE IF NOT EXISTS jarvis_study_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handoff_id TEXT NOT NULL UNIQUE REFERENCES jarvis_study_handoffs(handoff_id),
        payload_json TEXT NOT NULL,
        source_system TEXT NOT NULL,
        legacy_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        UNIQUE(source_system, legacy_id)
      );
    `);
    this.tasks = new TaskService(this.database, options?.ownerId);
  }

  close(): void { this.database.close(); }

  createTask(input: TaskCreateInput): JarvisTask { return this.tasks.create(input); }

  listTasks(status: TaskStatus | "all" = "pending"): JarvisTask[] {
    return this.tasks.list(status);
  }

  updateTask(input: TaskUpdateInput): JarvisTask { return this.tasks.update(input); }

  completeTask(id: number, completedAt?: string, options?: { expectedRevision: number; idempotencyKey: string }): JarvisTask {
    return this.tasks.complete(id, completedAt, options);
  }

  listTaskSyncIntents(): TaskSyncIntent[] { return this.tasks.listSyncIntents(); }
  claimTaskSyncIntents(limit = 20): TaskSyncIntent[] { return this.tasks.claimSyncIntents(limit); }
  settleTaskSyncIntent(input: TaskSyncSettlement): void { this.tasks.settleSyncIntent(input); }
  markInterruptedTaskSyncUnknown(): number { return this.tasks.markInterruptedSyncUnknown(); }

  createReminder(input: {
    id?: number;
    message: string;
    scheduledAt?: string | null;
    status?: ReminderStatus;
    pausedReason?: string | null;
  } & ProvenanceInput): JarvisReminder {
    const content = { message: input.message.trim(), scheduledAt: input.scheduledAt ?? null };
    const source = provenance(input, content);
    const columns = input.id === undefined ? "" : "id,";
    const placeholder = input.id === undefined ? "" : "?,";
    const values = input.id === undefined ? [] : [input.id];
    this.database.prepare(`INSERT OR IGNORE INTO jarvis_reminders (${columns}message,scheduled_at,status,paused_reason,claimed_at,sent_at,source_system,legacy_id,source_hash,imported_at)
      VALUES (${placeholder}?,?,?,?,NULL,NULL,?,?,?,?)`).run(
      ...values, content.message, content.scheduledAt, input.status ?? "scheduled", input.pausedReason ?? null,
      source.sourceSystem, source.legacyId, source.sourceHash, source.importedAt,
    );
    const row = this.database.prepare("SELECT * FROM jarvis_reminders WHERE source_system=? AND legacy_id=?").get(source.sourceSystem, source.legacyId) as unknown as SqlReminderRow | undefined;
    if (!row) throw new Error("Reminder ID conflicts with an existing record.");
    if (row.source_hash !== source.sourceHash) throw new Error("Reminder idempotency key was reused with different content.");
    return reminderFromRow(row);
  }

  listReminders(): JarvisReminder[] {
    return (this.database.prepare("SELECT * FROM jarvis_reminders ORDER BY COALESCE(scheduled_at,'9999'), id").all() as unknown as SqlReminderRow[]).map(reminderFromRow);
  }

  claimDueReminders(now: string, limit = 20): JarvisReminder[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Reminder claim limit must be between 1 and 100.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`SELECT * FROM jarvis_reminders
        WHERE status='scheduled' AND scheduled_at IS NOT NULL AND datetime(scheduled_at)<=datetime(?)
        ORDER BY scheduled_at,id LIMIT ?`).all(now, limit) as unknown as SqlReminderRow[];
      const claim = this.database.prepare("UPDATE jarvis_reminders SET status='dispatching', claimed_at=? WHERE id=? AND status='scheduled'");
      const claimed: JarvisReminder[] = [];
      for (const row of rows) {
        if (claim.run(now, row.id).changes === 1) claimed.push(reminderFromRow({ ...row, status: "dispatching", claimed_at: now }));
      }
      this.database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markReminderSent(id: number, sentAt: string): void {
    this.database.prepare("UPDATE jarvis_reminders SET status='sent',sent_at=? WHERE id=? AND status='dispatching'").run(sentAt, id);
  }

  markReminderReviewRequired(id: number, reason: string): void {
    this.database.prepare("UPDATE jarvis_reminders SET status='review_required',paused_reason=? WHERE id=? AND status='dispatching'").run(reason, id);
  }

  quarantineInterruptedDispatches(): number {
    return Number(this.database.prepare(`UPDATE jarvis_reminders
      SET status='review_required',paused_reason='dispatch_interrupted_before_acknowledgement'
      WHERE status='dispatching'`).run().changes);
  }

  recordAcademicFact(input: {
    subject: string;
    factType: string;
    value: unknown;
    effectiveDate?: string | null;
    status?: "active" | "review_required";
  } & ProvenanceInput): void {
    const content = { subject: input.subject, factType: input.factType, value: input.value, effectiveDate: input.effectiveDate ?? null };
    const source = provenance(input, content);
    this.database.prepare(`INSERT OR IGNORE INTO jarvis_academic_facts
      (subject,fact_type,value_json,effective_date,status,source_system,legacy_id,source_hash,imported_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      input.subject, input.factType, JSON.stringify(input.value), input.effectiveDate ?? null, input.status ?? "active",
      source.sourceSystem, source.legacyId, source.sourceHash, source.importedAt,
    );
    const row = this.database.prepare("SELECT source_hash FROM jarvis_academic_facts WHERE source_system=? AND legacy_id=?").get(source.sourceSystem, source.legacyId) as unknown as { source_hash: string } | undefined;
    if (!row) throw new Error("Academic fact conflicts with an existing record.");
    if (row.source_hash !== source.sourceHash) throw new Error("Academic fact idempotency key was reused with different content.");
  }

  listAcademicFacts(): Array<Record<string, unknown>> {
    return this.database.prepare("SELECT * FROM jarvis_academic_facts ORDER BY id").all() as Array<Record<string, unknown>>;
  }

  recordMaterial(input: Omit<StudyMaterial, "id" | "sourceHash" | "importedAt"> & Partial<Pick<StudyMaterial, "sourceHash" | "importedAt">>): void {
    const content = { fileName: input.fileName, subject: input.subject, topic: input.topic, availability: input.availability };
    const source = provenance({ sourceSystem: input.sourceSystem, legacyId: input.legacyId, ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}), ...(input.importedAt ? { importedAt: input.importedAt } : {}) }, content);
    this.database.prepare(`INSERT OR IGNORE INTO jarvis_study_materials
      (file_name,subject,topic,availability,source_system,legacy_id,source_hash,imported_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      input.fileName, input.subject, input.topic, input.availability, source.sourceSystem, source.legacyId, source.sourceHash, source.importedAt,
    );
    const row = this.database.prepare("SELECT source_hash FROM jarvis_study_materials WHERE source_system=? AND legacy_id=?").get(source.sourceSystem, source.legacyId) as unknown as { source_hash: string } | undefined;
    if (!row) throw new Error("Study material conflicts with an existing record.");
    if (row.source_hash !== source.sourceHash) throw new Error("Study material idempotency key was reused with different content.");
  }

  listMaterials(): StudyMaterial[] {
    const rows = this.database.prepare("SELECT * FROM jarvis_study_materials ORDER BY id").all() as unknown as SqlMaterialRow[];
    return rows.map((row) => ({ id: row.id, fileName: row.file_name, subject: row.subject, topic: row.topic, availability: row.availability, sourceSystem: row.source_system, legacyId: row.legacy_id, sourceHash: row.source_hash, importedAt: row.imported_at }));
  }

  recordHandoff(input: Omit<StudyHandoff, "sourceHash" | "importedAt"> & Partial<Pick<StudyHandoff, "sourceHash" | "importedAt">>): void {
    const source = provenance({ sourceSystem: input.sourceSystem, legacyId: input.legacyId, ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}), ...(input.importedAt ? { importedAt: input.importedAt } : {}) }, input);
    this.database.prepare(`INSERT OR IGNORE INTO jarvis_study_handoffs
      (handoff_id,subject,focus,material_legacy_id,status,source_system,legacy_id,source_hash,imported_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      input.handoffId, input.subject, input.focus, input.materialLegacyId, input.status, source.sourceSystem, source.legacyId, source.sourceHash, source.importedAt,
    );
    const row = this.database.prepare("SELECT source_hash FROM jarvis_study_handoffs WHERE source_system=? AND legacy_id=?").get(source.sourceSystem, source.legacyId) as unknown as { source_hash: string } | undefined;
    if (!row) throw new Error("Study handoff conflicts with an existing record.");
    if (row.source_hash !== source.sourceHash) throw new Error("Study handoff idempotency key was reused with different content.");
  }

  listHandoffs(): StudyHandoff[] {
    const rows = this.database.prepare("SELECT * FROM jarvis_study_handoffs ORDER BY imported_at,handoff_id").all() as unknown as SqlHandoffRow[];
    return rows.map((row) => ({ handoffId: row.handoff_id, subject: row.subject, focus: row.focus, materialLegacyId: row.material_legacy_id, status: row.status, sourceSystem: row.source_system, legacyId: row.legacy_id, sourceHash: row.source_hash, importedAt: row.imported_at }));
  }

  ingestStudyReport(payload: unknown, sourceSystem: string, legacyId?: string): { id: number; handoffId: string } {
    const report = validateStudyReport(payload);
    const content = JSON.stringify(report);
    const source = provenance({ sourceSystem, ...(legacyId ? { legacyId } : { legacyId: `${report.handoffId}:${canonicalHash(report)}` }) }, report);
    this.database.prepare(`INSERT OR IGNORE INTO jarvis_study_reports
      (handoff_id,payload_json,source_system,legacy_id,source_hash,imported_at) VALUES (?,?,?,?,?,?)`).run(
      report.handoffId, content, source.sourceSystem, source.legacyId, source.sourceHash, source.importedAt,
    );
    const row = this.database.prepare("SELECT id,handoff_id,source_hash FROM jarvis_study_reports WHERE handoff_id=?").get(report.handoffId) as unknown as { id: number; handoff_id: string; source_hash: string } | undefined;
    if (!row) throw new Error("Study handoff does not exist or report could not be stored.");
    if (row.source_hash !== source.sourceHash) throw new Error("Study handoff already has a different report.");
    this.database.prepare("UPDATE jarvis_study_handoffs SET status='reported' WHERE handoff_id=?").run(report.handoffId);
    return { id: row.id, handoffId: row.handoff_id };
  }
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function boundedArray<T>(value: unknown, label: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error(`${label} must contain at most 8 items.`);
  return value.map(parse);
}

export function validateStudyReport(value: unknown): StudyReport {
  if (typeof value !== "object" || value === null) throw new Error("Study report must be an object.");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "unab-os.study-report.v1") throw new Error("Unsupported study report schemaVersion.");
  const confidence = input.confidence;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") throw new Error("Study report confidence is invalid.");
  return {
    schemaVersion: "unab-os.study-report.v1",
    handoffId: boundedText(input.handoffId, "handoffId", 128),
    summary: boundedText(input.summary, "summary", 2000),
    strengths: boundedArray(input.strengths, "strengths", (item) => {
      const pair = item as Record<string, unknown>;
      return { topic: boundedText(pair?.topic, "strength topic", 200), evidence: boundedText(pair?.evidence, "strength evidence", 1000) };
    }),
    weaknesses: boundedArray(input.weaknesses, "weaknesses", (item) => {
      const pair = item as Record<string, unknown>;
      return { topic: boundedText(pair?.topic, "weakness topic", 200), evidence: boundedText(pair?.evidence, "weakness evidence", 1000) };
    }),
    questionsMissed: boundedArray(input.questionsMissed, "questionsMissed", (item) => {
      const pair = item as Record<string, unknown>;
      return { question: boundedText(pair?.question, "missed question", 1000), reason: boundedText(pair?.reason, "missed reason", 1000) };
    }),
    confidence,
    nextActions: boundedArray(input.nextActions, "nextActions", (item) => {
      const pair = item as Record<string, unknown>;
      const minutes = pair?.minutes;
      if (!Number.isInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 240) throw new Error("next action minutes must be between 5 and 240.");
      return { action: boundedText(pair?.action, "next action", 500), minutes: minutes as number };
    }),
  };
}

export async function dispatchDueReminders(
  store: LegacyStore,
  send: (reminder: JarvisReminder) => Promise<void>,
  now = new Date().toISOString(),
  limit = 20,
): Promise<{ sent: number; reviewRequired: number }> {
  const claimed = store.claimDueReminders(now, limit);
  let sent = 0;
  let reviewRequired = 0;
  for (const reminder of claimed) {
    try {
      await send(reminder);
      store.markReminderSent(reminder.id, now);
      sent += 1;
    } catch {
      // Telegram failures can be ambiguous. Never retry automatically because a
      // successful request followed by a lost response would produce duplicates.
      store.markReminderReviewRequired(reminder.id, "delivery_outcome_unknown");
      reviewRequired += 1;
    }
  }
  return { sent, reviewRequired };
}

const LEGACY_SOURCE = "legacy-transcript";

export function seedVerifiedLegacyRecords(store: LegacyStore, importedAt = new Date().toISOString()): void {
  store.createTask({
    id: 18,
    title: "Preparar quiz de Circuitos hasta el Teorema de Thévenin, sin incluirlo",
    subject: "Circuitos",
    dueDate: "2026-09-10",
    dueAt: null,
    sourceSystem: LEGACY_SOURCE,
    legacyId: "task-18",
    importedAt,
  });
  store.recordAcademicFact({
    subject: "Circuitos",
    factType: "quiz_conditions",
    value: { dueDate: "2026-09-10", scope: "Hasta el Teorema de Thevenin, sin incluirlo", conditions: "Sin apuntes; un ejercicio de clase", timeKnown: false },
    effectiveDate: "2026-09-10",
    sourceSystem: LEGACY_SOURCE,
    legacyId: "circuitos-quiz-2026-09-10",
    importedAt,
  });
  const reminderMessages = [
    "Bloque de Estadística: resuelve TallerParcial1 preguntas 1 a 3.",
    "Revisa Circuitos y Estadística para los parciales del martes.",
    "Materiales: la recuperación visible en TEMA cierra hoy a las 13:00.",
  ];
  reminderMessages.forEach((message, index) => store.createReminder({
    message,
    scheduledAt: null,
    status: "review_required",
    pausedReason: "legacy_due_time_unavailable",
    sourceSystem: LEGACY_SOURCE,
    legacyId: `reminder-${index + 1}`,
    importedAt,
  }));
  const materials = [
    ["material-oscillations", "GuiaOsciolaciones_Ondas--candidate-0290.pdf", "Física", "Oscilaciones y ondas"],
    ["material-edo-unit-1", "Paquete_Ecuaciones_Diferenciales_Unidad_I.pdf", "EDO", "Unidad I"],
    ["material-normal-table", "Tabla-Normal-Estandar--candidate-0004.pdf", "Estadística", "Distribución normal"],
    ["material-edo-guide", "Guia_de_Aprendizaje_Ecuaciones_Diferenciales_202660_candidate.pdf", "EDO", "Guía de aprendizaje"],
  ] as const;
  for (const [legacyId, fileName, subject, topic] of materials) {
    store.recordMaterial({ fileName, subject, topic, availability: "unavailable", sourceSystem: LEGACY_SOURCE, legacyId, importedAt });
  }
  const handoffs = [
    ["6af29b73-89e9-455a-b165-44c6d6a73bc2", "Física", "Oscilaciones", "material-oscillations"],
    ["d6480226-f4b8-48fb-9b10-927ff7d85cbe", "EDO", "Unidad I", "material-edo-unit-1"],
    ["9dc95cee-1249-4113-86f5-44381c9a52e0", "Estadística", "Distribución normal", "material-normal-table"],
    ["ea149974-3d8e-4abc-88bd-d7a732d11825", "EDO", "Guía de aprendizaje", "material-edo-guide"],
  ] as const;
  for (const [handoffId, subject, focus, materialLegacyId] of handoffs) {
    const content = { handoffId, subject, focus, materialLegacyId };
    store.recordHandoff({
      ...content,
      status: "legacy_reference",
      sourceSystem: LEGACY_SOURCE,
      legacyId: `handoff-${handoffId}`,
      sourceHash: canonicalHash(content),
      importedAt,
    });
  }
}
