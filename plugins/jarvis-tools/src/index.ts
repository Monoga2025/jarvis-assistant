import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { AssistantModeStore, assistantModePrompt } from "./assistant-mode.js";
import { GoogleCalendarRestClient, GoogleOAuthTokenProvider, JarvisCalendarService } from "./calendar.js";
import { CHECK_IN_KINDS, CoachingStore } from "./coaching.js";
import { CoupleStore, type CouplePartyId } from "./couple.js";
import {
  FinanceStore,
  PdfJsTextExtractor,
  parseBancoOccidente,
  parseNequi,
  redactAmbiguities,
  resolveImportIcs,
  resolveImportPdf,
} from "./finance.js";
import { importAcademicIcs } from "./ics.js";
import { LegacyStore } from "./legacy.js";
import { handleJarvisCallback } from "./notifications.js";
import { SalesStore } from "./sales.js";
import { closeDay, guideDay, planDay, planWeek, type ScheduleBlock } from "./routine.js";
import { GoogleDriveOAuthTokenProvider } from "./drive-auth.js";
import { GoogleDriveClient } from "./drive-client.js";
import { DriveStore } from "./drive-store.js";
import { syncDriveMaterials } from "./drive-sync.js";

export const TOOL_NAMES = [
  "assistant_mode_get",
  "assistant_mode_set",
  "calendar_read_busy_range",
  "calendar_read_agenda_range",
  "calendar_create_flexible_block",
  "calendar_reschedule_managed_block",
  "finance_import_statement",
  "finance_reconcile_month",
  "couple_record_shared_expense",
  "couple_record_settlement",
  "couple_summary",
  "coaching_record_checkin",
  "coaching_summary",
  "coaching_claim_proactive",
  "sales_create_prospect",
  "sales_prepare_outreach",
  "sales_record_outcome",
  "sales_metrics_30_days",
  "routine_plan_day",
  "routine_close_day",
  "routine_plan_week",
  "routine_guide_today",
  "academic_import_ics",
  "task_create",
  "task_list",
  "task_complete",
  "reminder_create",
  "reminder_list",
  "academic_fact_record",
  "academic_fact_list",
  "study_handoff_create",
  "study_handoff_list",
  "study_report_ingest",
  "study_material_record",
  "study_material_list",
  "drive_materials_sync",
  "drive_materials_list",
] as const;

const configSchema = Type.Object({
  primaryCalendarId: Type.String({ minLength: 1 }),
  managedCalendarId: Type.String({ minLength: 1 }),
  importDirectory: Type.String({ minLength: 1 }),
  databasePath: Type.String({ minLength: 1 }),
  googleClientIdFile: Type.String({ minLength: 1 }),
  googleClientSecretFile: Type.String({ minLength: 1 }),
  googleRefreshTokenFile: Type.String({ minLength: 1 }),
  googleDriveClientIdFile: Type.Optional(Type.String({ minLength: 1 })),
  googleDriveClientSecretFile: Type.Optional(Type.String({ minLength: 1 })),
  googleDriveRefreshTokenFile: Type.Optional(Type.String({ minLength: 1 })),
  googleDriveFolderId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const rangeSchema = Type.Object({
  start: Type.String({ format: "date-time" }),
  end: Type.String({ format: "date-time" }),
}, { additionalProperties: false });

const partyIdSchema = Type.Union([Type.Literal("alex"), Type.Literal("sam")]);
const taskDeadlineSchema = Type.Object({
  precision: Type.Union([Type.Literal("unknown"), Type.Literal("day"), Type.Literal("range"), Type.Literal("time")]),
  date: Type.Optional(Type.String({ format: "date" })), startDate: Type.Optional(Type.String({ format: "date" })),
  endDate: Type.Optional(Type.String({ format: "date" })), at: Type.Optional(Type.String({ format: "date-time" })),
  originalText: Type.Optional(Type.String({ maxLength: 1000 })), sourceReference: Type.Optional(Type.String({ maxLength: 500 })),
  confidence: Type.Optional(Type.Union([Type.Literal("unknown"), Type.Literal("reported"), Type.Literal("inferred")])),
}, { additionalProperties: false });
const BANCO_OCCIDENTE_ACCOUNT_OWNERS = new Map<string, CouplePartyId>([
  ["sam-occidente", "sam"],
]);

function importAccountOwner(provider: "nequi" | "banco_occidente", accountId: string): CouplePartyId {
  if (provider === "nequi") return "alex";
  const owner = BANCO_OCCIDENTE_ACCOUNT_OWNERS.get(accountId);
  if (!owner) throw new Error("Banco de Occidente accountId is not registered in the server-owned account map.");
  return owner;
}

const blockSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  kind: Type.Union([
    Type.Literal("class"), Type.Literal("exam"), Type.Literal("commitment"), Type.Literal("study"),
    Type.Literal("sales"), Type.Literal("gym"), Type.Literal("meal"), Type.Literal("rest"), Type.Literal("church"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  start: Type.String({ format: "date-time" }),
  end: Type.String({ format: "date-time" }),
  protected: Type.Boolean(),
}, { additionalProperties: false });

function calendarService(config: {
  primaryCalendarId: string;
  managedCalendarId: string;
  googleClientIdFile: string;
  googleClientSecretFile: string;
  googleRefreshTokenFile: string;
}): JarvisCalendarService {
  const tokenProvider = new GoogleOAuthTokenProvider(async () => {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      readFile(config.googleClientIdFile, "utf8"),
      readFile(config.googleClientSecretFile, "utf8"),
      readFile(config.googleRefreshTokenFile, "utf8"),
    ]);
    return {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      refreshToken: refreshToken.trim(),
    };
  });
  return new JarvisCalendarService(new GoogleCalendarRestClient(tokenProvider), config);
}

const plugin = defineToolPlugin({
  id: "jarvis-tools",
  name: "Jarvis deterministic tools",
  description: "Narrow tools for a single-operator personal operating system.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "assistant_mode_get",
      description: "Read whether Jarvis is in friendly normal mode or an explicitly activated work session.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new AssistantModeStore(config.databasePath);
        try { return store.get(); } finally { store.close(); }
      },
    }),
    tool({
      name: "assistant_mode_set",
      description: "Enter work mode only after explicit natural-language intent, or return to normal mode after natural-language intent. Never infer activation from a deadline alone.",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("normal"), Type.Literal("work")]),
        goal: Type.Optional(Type.String({ maxLength: 240 })),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new AssistantModeStore(config.databasePath);
        try { return store.set({ ...params, sourceSystem: "jarvis-agent" }); } finally { store.close(); }
      },
    }),
    tool({
      name: "calendar_read_busy_range",
      description: "Read merged free/busy intervals from the read-only primary and managed calendars.",
      parameters: rangeSchema,
      optional: true,
      execute: (params, config) => calendarService(config).readBusyRange(params),
    }),
    tool({
      name: "calendar_read_agenda_range",
      description: "Answer natural agenda questions from the primary calendar (id, title, description, start, end, location) and Jarvis Plan (id, title, start, end, location). Never modify primary events.",
      parameters: rangeSchema,
      optional: true,
      execute: (params, config) => calendarService(config).readAgendaRange(params),
    }),
    tool({
      name: "calendar_create_flexible_block",
      description: "Create a marker-owned flexible block in the dedicated managed calendar.",
      parameters: Type.Object({
        blockId: Type.String({ minLength: 1, maxLength: 128 }),
        summary: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Optional(Type.String({ maxLength: 2000 })),
        start: Type.String({ format: "date-time" }),
        end: Type.String({ format: "date-time" }),
      }, { additionalProperties: false }),
      optional: true,
      execute: (params, config) => calendarService(config).createFlexibleBlock(params),
    }),
    tool({
      name: "calendar_reschedule_managed_block",
      description: "Reschedule one event only after its Jarvis ownership markers match.",
      parameters: Type.Object({
        eventId: Type.String({ minLength: 1, maxLength: 256 }),
        blockId: Type.String({ minLength: 1, maxLength: 128 }),
        start: Type.String({ format: "date-time" }),
        end: Type.String({ format: "date-time" }),
      }, { additionalProperties: false }),
      optional: true,
      execute: (params, config) => calendarService(config).rescheduleManagedBlock(params),
    }),
    tool({
      name: "finance_import_statement",
      description: "Extract and import one local Nequi or Banco de Occidente PDF from the bounded import directory.",
      parameters: Type.Object({
        fileName: Type.String({ minLength: 1, maxLength: 255 }),
        provider: Type.Union([Type.Literal("nequi"), Type.Literal("banco_occidente")]),
        accountId: Type.String({ minLength: 1, maxLength: 120 }),
        partyId: Type.Optional(partyIdSchema),
      }, { additionalProperties: false }),
      optional: true,
      async execute(params, config) {
        const accountOwner = importAccountOwner(params.provider, params.accountId);
        const partyId = params.partyId ?? (params.provider === "nequi" ? accountOwner : undefined);
        if (!partyId) throw new Error("Banco de Occidente imports require an explicit partyId and personal scoped consent.");
        if (partyId !== accountOwner) {
          const ownerName = accountOwner === "sam" ? "Sam" : "Alex";
          throw new Error(`Account ${params.accountId} belongs to ${ownerName}; partyId cannot override server-owned ownership.`);
        }
        const couple = new CoupleStore(config.databasePath);
        try { couple.assertBankStatementImportAllowed(accountOwner); } finally { couple.close(); }
        const filePath = await resolveImportPdf(config.importDirectory, params.fileName);
        const text = await new PdfJsTextExtractor().extract(filePath);
        const parsed = params.provider === "nequi"
          ? parseNequi(text, params.accountId)
          : parseBancoOccidente(text, params.accountId);
        const store = new FinanceStore(config.databasePath);
        try {
          const inserted = store.save(parsed.transactions);
          return {
            parsed: parsed.transactions.length,
            inserted,
            duplicateCount: parsed.transactions.length - inserted,
            unparsedCount: parsed.unparsedLines.length,
            ambiguities: redactAmbiguities(parsed.unparsedLines).slice(0, 100),
            requiresManualReview: parsed.unparsedLines.length > 0,
          };
        } finally {
          store.close();
        }
      },
    }),
    tool({
      name: "finance_reconcile_month",
      description: "Reconcile one YYYY-MM month from locally persisted normalized transactions.",
      parameters: Type.Object({ month: Type.String({ pattern: "^\\d{4}-\\d{2}$" }) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new FinanceStore(config.databasePath);
        try { return store.reconcile(params.month); } finally { store.close(); }
      },
    }),
    tool({
      name: "couple_record_shared_expense",
      description: "Record one manually confirmed shared expense in integer COP with exact allocations; this never accesses a bank or moves money.",
      parameters: Type.Object({
        description: Type.String({ minLength: 1, maxLength: 300 }),
        amountCop: Type.Integer({ minimum: 1 }),
        incurredOn: Type.String({ format: "date" }),
        paidByPartyId: partyIdSchema,
        allocations: Type.Array(Type.Object({
          partyId: partyIdSchema,
          amountCop: Type.Integer({ minimum: 1 }),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 2 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new CoupleStore(config.databasePath);
        try { return store.recordSharedExpense({ ...params, sourceSystem: "jarvis-agent" }); } finally { store.close(); }
      },
    }),
    tool({
      name: "couple_record_settlement",
      description: "Record one manually confirmed settlement for accounting only; this never initiates a transfer or counts it as income or spending.",
      parameters: Type.Object({
        fromPartyId: partyIdSchema,
        toPartyId: partyIdSchema,
        amountCop: Type.Integer({ minimum: 1 }),
        occurredOn: Type.String({ format: "date" }),
        note: Type.Optional(Type.String({ maxLength: 500 })),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new CoupleStore(config.databasePath);
        try { return store.recordSettlement({ ...params, sourceSystem: "jarvis-agent" }); } finally { store.close(); }
      },
    }),
    tool({
      name: "couple_summary",
      description: "View the local couple ledger summary, consent status, exact balances, and settlement totals without changing anything.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new CoupleStore(config.databasePath);
        try { return store.summary(); } finally { store.close(); }
      },
    }),
    tool({
      name: "coaching_record_checkin",
      description: "Record one evidence-backed study, gym, meal-prep, or deep-work completion without points, punishment, or spending.",
      parameters: Type.Object({
        kind: Type.Union(CHECK_IN_KINDS.map((kind) => Type.Literal(kind))),
        occurredAt: Type.String({ format: "date-time" }),
        evidence: Type.String({ minLength: 1, maxLength: 500 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new CoachingStore(config.databasePath);
        try { return store.recordCheckIn({ ...params, sourceSystem: "jarvis-agent" }); } finally { store.close(); }
      },
    }),
    tool({
      name: "coaching_summary",
      description: "View current-week consistency, streaks, and bounded gaming eligibility based only on recorded evidence and daily close state.",
      parameters: Type.Object({ asOf: Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new CoachingStore(config.databasePath);
        try { return store.summary(params.asOf); } finally { store.close(); }
      },
    }),
    tool({
      name: "coaching_claim_proactive",
      description: "Atomically claim one bounded proactive coaching signature, honoring owner disablement, deduplication, and the fixed cooldown.",
      parameters: Type.Object({ signature: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new CoachingStore(config.databasePath);
        try { return store.claimProactive(params.signature); } finally { store.close(); }
      },
    }),
    tool({
      name: "sales_create_prospect",
      description: "Create a researched prospect in the local transactional sales pipeline.",
      parameters: Type.Object({
        companyName: Type.String({ minLength: 1, maxLength: 160 }),
        contactName: Type.String({ minLength: 1, maxLength: 120 }),
        contactChannel: Type.String({ minLength: 1, maxLength: 120 }),
        source: Type.String({ minLength: 1, maxLength: 120 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new SalesStore(config.databasePath);
        try { return store.createProspect(params); } finally { store.close(); }
      },
    }),
    tool({
      name: "sales_prepare_outreach",
      description: "Prepare but never send a prospect message; the result requires operator approval.",
      parameters: Type.Object({ prospectId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new SalesStore(config.databasePath);
        try { return store.prepareOutreach(params.prospectId); } finally { store.close(); }
      },
    }),
    tool({
      name: "sales_record_outcome",
      description: "Record an operator-confirmed sales outcome in the local pipeline.",
      parameters: Type.Object({
        prospectId: Type.String({ minLength: 1 }),
        outcome: Type.Union([Type.Literal("contacted"), Type.Literal("conversation"), Type.Literal("diagnosis"), Type.Literal("won"), Type.Literal("lost")]),
        occurredAt: Type.Optional(Type.String({ format: "date-time" })),
        contractedCents: Type.Optional(Type.Integer({ minimum: 1 })),
        note: Type.Optional(Type.String({ maxLength: 1000 })),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new SalesStore(config.databasePath);
        try { return store.recordOutcome(params); } finally { store.close(); }
      },
    }),
    tool({
      name: "sales_metrics_30_days",
      description: "Compute the local rolling 30-day sales funnel.",
      parameters: Type.Object({ asOf: Type.String({ format: "date-time" }) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new SalesStore(config.databasePath);
        try { return store.metrics30Days(params.asOf); } finally { store.close(); }
      },
    }),
    tool({
      name: "routine_plan_day",
      description: "Plan a day deterministically while preserving every protected block.",
      parameters: Type.Object({
        date: Type.String({ format: "date" }),
        fixedBlocks: Type.Array(blockSchema, { maxItems: 64 }),
        flexibleBlocks: Type.Array(blockSchema, { maxItems: 64 }),
      }, { additionalProperties: false }),
      optional: true,
      execute: (params) => planDay({
        date: params.date,
        fixedBlocks: params.fixedBlocks as ScheduleBlock[],
        flexibleBlocks: params.flexibleBlocks as ScheduleBlock[],
      }),
    }),
    tool({
      name: "routine_close_day",
      description: "Close a day and identify only flexible missed blocks for requeueing.",
      parameters: Type.Object({
        blocks: Type.Array(blockSchema, { maxItems: 128 }),
        completedBlockIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 128 }),
        blocker: Type.Optional(Type.String({ maxLength: 1000 })),
        date: Type.Optional(Type.String({ format: "date" })),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const result = closeDay({
          blocks: params.blocks as ScheduleBlock[],
          completedBlockIds: params.completedBlockIds,
          ...(params.blocker === undefined ? {} : { blocker: params.blocker }),
        });
        const localDate = params.date ?? new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());
        const keyHash = createHash("sha256").update(JSON.stringify({ localDate, critical: result.protectedMisses.length === 0 })).digest("hex");
        const coaching = new CoachingStore(config.databasePath);
        try {
          coaching.recordDayClose({
            localDate,
            criticalCommitmentsComplete: result.protectedMisses.length === 0,
            dailyCloseComplete: true,
            sourceSystem: "routine-close",
            idempotencyKey: `routine-close:${keyHash}`,
          });
        } finally {
          coaching.close();
        }
        return { ...result, coachingRecorded: true };
      },
    }),
    tool({
      name: "routine_plan_week",
      description: "Return normal or exam-week operating targets without reducing sleep or meals.",
      parameters: Type.Object({ examMode: Type.Boolean() }, { additionalProperties: false }),
      optional: true,
      execute: (params) => planWeek(params.examMode),
    }),
    tool({
      name: "routine_guide_today",
      description: "Provide the executive daily guide for Alex, automatically resolving classes, transit (commute), lunch, and high-priority study blocks without decision fatigue.",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ format: "date" })),
        examMode: Type.Optional(Type.Boolean()),
        fixedBlocks: Type.Optional(Type.Array(blockSchema, { maxItems: 64 })),
      }, { additionalProperties: false }),
      optional: true,
      async execute(params, config) {
        const targetDate = params.date ?? new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());

        const fixedBlocks: ScheduleBlock[] = [...((params.fixedBlocks as ScheduleBlock[] | undefined) ?? [])];

        if (fixedBlocks.length === 0) {
          try {
            const service = calendarService(config);
            const dayStart = `${targetDate}T00:00:00-05:00`;
            const dayEnd = `${targetDate}T23:59:59-05:00`;
            const agenda = await service.readAgendaRange({ start: dayStart, end: dayEnd });
            for (const item of agenda) {
              const lower = item.summary.toLowerCase();
              const isClass = lower.includes("clase") || lower.includes("unab") || lower.includes("aula") || lower.includes("lab") || lower.includes("materia") || item.extendedProperties?.private?.jarvisManaged !== "true";
              const id = item.id ?? createHash("sha256").update(`${item.summary}:${item.start}`).digest("hex").slice(0, 16);
              fixedBlocks.push({
                id,
                kind: isClass ? "class" : "commitment",
                title: item.summary,
                start: item.start,
                end: item.end,
                protected: true,
              });
            }
          } catch {
            // Calendar unconfigured or offline; proceed with empty or provided blocks
          }
        }

        const legacyStore = new LegacyStore(config.databasePath);
        let tasks: Array<{ id: number; title: string; subject: string; dueAt?: string | null; dueDate?: string | null }> = [];
        try {
          const pendingTasks = legacyStore.listTasks("pending");
          tasks = pendingTasks.map((t) => ({
            id: t.id,
            title: t.title,
            subject: t.subject,
            dueAt: t.dueAt,
            dueDate: t.dueDate,
          }));
        } finally {
          legacyStore.close();
        }

        return guideDay({
          date: targetDate,
          fixedBlocks,
          tasks,
          examMode: params.examMode ?? false,
        });
      },
    }),
    tool({
      name: "academic_import_ics",
      description: "Import Alex's protected academic events from one bounded local ICS file for the configured term.",
      parameters: Type.Object({ fileName: Type.String({ minLength: 1, maxLength: 255 }) }, { additionalProperties: false }),
      optional: true,
      async execute(params, config) {
        const filePath = await resolveImportIcs(config.importDirectory, params.fileName);
        const source = await readFile(filePath, "utf8");
        const imported = importAcademicIcs(source, {
          category: "Alex",
          timeZone: "America/Bogota",
          termStart: "2026-08-03",
          termEnd: "2026-11-20",
        });
        const service = calendarService(config);
        const persistedIds: string[] = [];
        for (const event of imported.accepted) {
          const persisted = await service.persistAcademicEvent(event);
          if (persisted.id) persistedIds.push(persisted.id);
        }
        return {
          acceptedCount: imported.accepted.length,
          persistedCount: persistedIds.length,
          persistedIds,
          rejected: imported.rejected.map((event) => ({ reason: event.reason })),
          ignoredCategoryCount: imported.ignoredCategoryCount,
        };
      },
    }),
    tool({
      name: "task_create",
      description: "Capture a durable personal task, or edit the same task using taskId and its expectedRevision from task_list. Preserve uncertain deadlines; plannedDate is independent. Never claim Google sync from local persistence.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }),
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        taskId: Type.Optional(Type.Integer({ minimum: 1 })),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        kind: Type.Optional(Type.Union([Type.Literal("unspecified"), Type.Literal("quiz"), Type.Literal("exam"), Type.Literal("homework"), Type.Literal("project"), Type.Literal("other")])),
        lifecycle: Type.Optional(Type.Union([Type.Literal("inbox"), Type.Literal("ready"), Type.Literal("in_progress"), Type.Literal("blocked")])),
        deadline: Type.Optional(taskDeadlineSchema),
        plannedDate: Type.Optional(Type.Union([Type.String({ format: "date" }), Type.Null()])),
        description: Type.Optional(Type.String({ maxLength: 4000 })),
        completionCriteria: Type.Optional(Type.String({ maxLength: 2000 })),
        dueDate: Type.Optional(Type.String({ format: "date" })),
        dueAt: Type.Optional(Type.String({ format: "date-time" })),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try {
          const { taskId, expectedRevision, idempotencyKey, lifecycle, ...changes } = params;
          if (taskId !== undefined) {
            if (expectedRevision === undefined) throw new Error("Editing requires expectedRevision from task_list.");
            return store.updateTask({ id: taskId, expectedRevision, idempotencyKey, sourceSystem: "jarvis-agent", changes: { ...changes, ...(lifecycle ? { lifecycle } : {}) } });
          }
          if (expectedRevision !== undefined || lifecycle !== undefined) throw new Error("Revision and lifecycle changes require an existing taskId.");
          return store.createTask({ ...changes, sourceSystem: "jarvis-agent", legacyId: idempotencyKey });
        } finally { store.close(); }
      },
    }),
    tool({
      name: "task_list",
      description: "List durable personal tasks without changing them.",
      parameters: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed"), Type.Literal("all")])) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.listTasks(params.status ?? "pending"); } finally { store.close(); }
      },
    }),
    tool({
      name: "task_complete",
      description: "Mark the owner task complete using its expectedRevision from task_list and an idempotency key. Completion is reported, not independently verified learning.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 1 }), expectedRevision: Type.Integer({ minimum: 1 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.completeTask(params.id, undefined, { expectedRevision: params.expectedRevision, idempotencyKey: params.idempotencyKey }); } finally { store.close(); }
      },
    }),
    tool({
      name: "reminder_create",
      description: "Create one durable model-independent reminder with an explicit idempotency key.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, maxLength: 1000 }),
        scheduledAt: Type.String({ format: "date-time" }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.createReminder({ ...params, sourceSystem: "jarvis-agent", legacyId: params.idempotencyKey }); } finally { store.close(); }
      },
    }),
    tool({
      name: "reminder_list",
      description: "List durable reminders, including quarantined legacy reminders.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.listReminders(); } finally { store.close(); }
      },
    }),
    tool({
      name: "academic_fact_record",
      description: "Record one bounded academic fact with provenance and an explicit idempotency key.",
      parameters: Type.Object({
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        factType: Type.String({ minLength: 1, maxLength: 120 }),
        value: Type.Unknown(),
        effectiveDate: Type.Optional(Type.String({ format: "date" })),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try {
          store.recordAcademicFact({ ...params, sourceSystem: "jarvis-agent", legacyId: params.idempotencyKey });
          return { recorded: true, idempotencyKey: params.idempotencyKey };
        } finally { store.close(); }
      },
    }),
    tool({
      name: "academic_fact_list",
      description: "List bounded academic facts without changing them.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.listAcademicFacts(); } finally { store.close(); }
      },
    }),
    tool({
      name: "study_handoff_create",
      description: "Create one bounded study handoff metadata record; this never transfers files.",
      parameters: Type.Object({
        handoffId: Type.String({ minLength: 1, maxLength: 128 }),
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        focus: Type.String({ minLength: 1, maxLength: 1000 }),
        materialLegacyId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try {
          store.recordHandoff({ handoffId: params.handoffId, subject: params.subject, focus: params.focus, materialLegacyId: params.materialLegacyId ?? null, status: "open", sourceSystem: "jarvis-agent", legacyId: params.idempotencyKey });
          return { handoffId: params.handoffId, recorded: true };
        } finally { store.close(); }
      },
    }),
    tool({
      name: "study_handoff_list",
      description: "List bounded study handoff metadata without changing it.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.listHandoffs(); } finally { store.close(); }
      },
    }),
    tool({
      name: "study_report_ingest",
      description: "Validate and ingest one unab-os.study-report.v1 payload for a known handoff.",
      parameters: Type.Object({
        report: Type.Unknown(),
        idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.ingestStudyReport(params.report, "jarvis-agent", params.idempotencyKey); } finally { store.close(); }
      },
    }),
    tool({
      name: "study_material_record",
      description: "Record bounded study material metadata only; this tool never reads or transfers a file.",
      parameters: Type.Object({
        fileName: Type.String({ minLength: 1, maxLength: 255 }),
        subject: Type.String({ minLength: 1, maxLength: 200 }),
        topic: Type.String({ minLength: 1, maxLength: 500 }),
        availability: Type.Union([Type.Literal("unavailable"), Type.Literal("metadata_only")]),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new LegacyStore(config.databasePath);
        try {
          store.recordMaterial({ fileName: params.fileName, subject: params.subject, topic: params.topic, availability: params.availability, sourceSystem: "jarvis-agent", legacyId: params.idempotencyKey });
          return { recorded: true, idempotencyKey: params.idempotencyKey };
        } finally { store.close(); }
      },
    }),
    tool({
      name: "study_material_list",
      description: "List bounded material metadata; unavailable legacy files remain explicitly unavailable.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      execute(_params, config) {
        const store = new LegacyStore(config.databasePath);
        try { return store.listMaterials(); } finally { store.close(); }
      },
    }),
    tool({
      name: "drive_materials_sync",
      description: "Synchronize bounded read-only metadata for academic materials in the allowlisted UNAB Google Drive folder. Never downloads content or writes to Drive.",
      parameters: Type.Object({
        folderId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        driveAccountId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      }, { additionalProperties: false }),
      optional: true,
      async execute(params, config) {
        const folderId = params.folderId ?? config.googleDriveFolderId;
        if (!folderId) throw new Error("Google Drive folderId is required.");
        const driveAccountId = params.driveAccountId ?? "alex-unab";

        const clientIdFile = config.googleDriveClientIdFile ?? config.googleClientIdFile;
        const clientSecretFile = config.googleDriveClientSecretFile ?? config.googleClientSecretFile;
        const refreshTokenFile = config.googleDriveRefreshTokenFile ?? config.googleRefreshTokenFile;

        const [clientId, clientSecret, refreshToken] = await Promise.all([
          readFile(clientIdFile, "utf8"),
          readFile(clientSecretFile, "utf8"),
          readFile(refreshTokenFile, "utf8"),
        ]);

        const tokenProvider = new GoogleDriveOAuthTokenProvider(async () => ({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          refreshToken: refreshToken.trim(),
        }));

        const client = new GoogleDriveClient(tokenProvider);
        const store = new DriveStore(config.databasePath);
        try {
          return await syncDriveMaterials(client, store, {
            driveAccountId,
            sourceFolderId: folderId,
            maxPages: params.maxPages,
          });
        } finally {
          store.close();
        }
      },
    }),
    tool({
      name: "drive_materials_list",
      description: "List bounded academic study materials indexed from the UNAB Google Drive folder without downloading content.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 200 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }, { additionalProperties: false }),
      optional: true,
      execute(params, config) {
        const store = new DriveStore(config.databasePath);
        try {
          return store.listMaterials({ query: params.query, limit: params.limit });
        } finally {
          store.close();
        }
      },
    }),
  ],
});

const registerTools = plugin.register;
plugin.register = (api) => {
  registerTools(api);
  const databasePath = api.pluginConfig?.databasePath;
  if (typeof databasePath !== "string" || databasePath.length === 0) throw new Error("Jarvis plugin databasePath is required.");
  api.registerMemoryPromptPreparation(async () => {
    const store = new AssistantModeStore(databasePath);
    try { return [assistantModePrompt(store.get())]; } finally { store.close(); }
  });
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: "jarvis",
    handler: async (context) => handleJarvisCallback(context as never, {
      databasePath,
      ownerId: process.env.TELEGRAM_OWNER_ID ?? "",
    }),
  });
};

export default plugin;
