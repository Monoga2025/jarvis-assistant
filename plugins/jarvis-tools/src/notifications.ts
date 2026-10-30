import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AssistantModeStore } from "./assistant-mode.js";
import { CoachingStore } from "./coaching.js";
import { LegacyStore, type JarvisReminder, type JarvisTask } from "./legacy.js";

type NotificationKind = "urgent" | "reminder";
type NotificationAction = "d" | "w" | "l";
type NotificationTaskSnapshot = Pick<JarvisTask, "id" | "title" | "subject" | "dueDate" | "dueAt" | "status" | "completedAt" | "sourceSystem" | "legacyId" | "sourceHash" | "importedAt">;

export interface NotificationActionRecord {
  kind: NotificationKind;
  token: string;
  sourceId: number;
  sourceInstance: string;
  label: string;
  ownerId: string;
  dateOnly: boolean;
  dueAt: string | null;
  taskRevision: number | null;
}

export interface UrgentClaim extends NotificationActionRecord {
  kind: "urgent";
  task: NotificationTaskSnapshot;
  dueInstance: string;
}

export interface RoutineClaim extends NotificationActionRecord {
  kind: "reminder";
  routineType: "morning" | "night";
}

interface TaskRow {
  task_revision: number;
  id: number;
  title: string;
  subject: string;
  due_date: string | null;
  due_at: string | null;
  status: "pending" | "completed";
  completed_at: string | null;
  source_system: string;
  legacy_id: string;
  source_hash: string;
  imported_at: string;
}

interface ActionRow {
  task_revision: number | null;
  token: string;
  source_kind: NotificationKind;
  source_id: number;
  source_instance: string;
  owner_id: string;
  label: string;
  date_only: number;
  due_at: string | null;
  status: "pending" | "consumed";
  consumed_action: NotificationAction | null;
}

export interface TelegramPresentation {
  html: string;
  plainText: string;
  buttons: Array<Array<{ text: string; callback_data: string }>>;
}

interface TelegramResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type TelegramFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<TelegramResponse>;

export class NotificationStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jarvis_notification_actions (
        token TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('urgent','reminder')),
        source_id INTEGER NOT NULL,
        source_instance TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        label TEXT NOT NULL,
        date_only INTEGER NOT NULL CHECK(date_only IN (0,1)),
        due_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','consumed')),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_action TEXT CHECK(consumed_action IN ('d','w','l')),
        task_revision INTEGER,
        UNIQUE(source_kind,source_id,source_instance)
      );
      CREATE TABLE IF NOT EXISTS jarvis_urgent_alerts (
        task_id INTEGER NOT NULL,
        due_instance TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE REFERENCES jarvis_notification_actions(token),
        status TEXT NOT NULL CHECK(status IN ('dispatching','sent','review_required')),
        claimed_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY(task_id,due_instance)
      );
      CREATE INDEX IF NOT EXISTS jarvis_urgent_alerts_recent ON jarvis_urgent_alerts(claimed_at);
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.database.prepare("PRAGMA table_info(jarvis_notification_actions)").all();
      if (!columns.some((column) => column.name === "task_revision")) this.database.exec("ALTER TABLE jarvis_notification_actions ADD COLUMN task_revision INTEGER");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.database.close(); }

  claimUrgentTask(now: string, ownerId: string): UrgentClaim | null {
    const instant = parseInstant(now);
    validateOwner(ownerId);
    if (this.isWorkMode()) return null;
    const cutoff = new Date(instant.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const horizon = instant.getTime() + 24 * 60 * 60 * 1000;
    const localDate = bogotaDate(instant);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const recent = this.database.prepare("SELECT 1 FROM jarvis_urgent_alerts WHERE datetime(claimed_at)>datetime(?) LIMIT 1").get(cutoff);
      if (recent) {
        this.database.exec("COMMIT");
        return null;
      }
      // Telegram notifications remain Alex-only; the Telegram chat ID is not a task-owner principal.
      const tasks = this.database.prepare(`SELECT t.*,m.revision AS task_revision FROM jarvis_tasks t JOIN jarvis_task_metadata m ON m.task_id=t.id
        WHERE m.owner_id='alex' AND t.status='pending' AND (t.due_at IS NOT NULL OR t.due_date IS NOT NULL)
        ORDER BY COALESCE(t.due_at,t.due_date),t.id LIMIT 200`).all() as unknown as TaskRow[];
      const candidate = tasks
        .map((row) => urgentCandidate(row, instant.getTime(), horizon, localDate))
        .filter((item): item is { row: TaskRow; dueInstance: string; dateOnly: boolean; dueAt: string | null; sortAt: number } => item !== null)
        .sort((a, b) => a.sortAt - b.sortAt || a.row.id - b.row.id)
        .find(({ row, dueInstance }) => !this.database.prepare(
          "SELECT 1 FROM jarvis_urgent_alerts WHERE task_id=? AND due_instance=?",
        ).get(row.id, dueInstance));
      if (!candidate) {
        this.database.exec("COMMIT");
        return null;
      }

      const token = newToken();
      this.database.prepare(`INSERT INTO jarvis_notification_actions
        (token,source_kind,source_id,source_instance,owner_id,label,date_only,due_at,status,created_at,task_revision)
        VALUES (?,'urgent',?,?,?,?,?,?,'pending',?,?)`).run(
        token,
        candidate.row.id,
        candidate.dueInstance,
        ownerId,
        candidate.row.title,
        candidate.dateOnly ? 1 : 0,
        candidate.dueAt,
        now,
        candidate.row.task_revision,
      );
      this.database.prepare(`INSERT INTO jarvis_urgent_alerts
        (task_id,due_instance,token,status,claimed_at) VALUES (?,?,?,'dispatching',?)`).run(
        candidate.row.id,
        candidate.dueInstance,
        token,
        now,
      );
      this.database.exec("COMMIT");
      return {
        kind: "urgent",
        token,
        sourceId: candidate.row.id,
        sourceInstance: candidate.dueInstance,
        label: candidate.row.title,
        ownerId,
        dateOnly: candidate.dateOnly,
        dueAt: candidate.dueAt,
        dueInstance: candidate.dueInstance,
        task: taskFromRow(candidate.row),
        taskRevision: candidate.row.task_revision,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createReminderAction(reminder: JarvisReminder, ownerId: string, now: string): NotificationActionRecord {
    validateOwner(ownerId);
    const sourceInstance = reminder.scheduledAt ?? `reminder:${reminder.id}`;
    const existing = this.database.prepare(`SELECT * FROM jarvis_notification_actions
      WHERE source_kind='reminder' AND source_id=? AND source_instance=?`).get(reminder.id, sourceInstance) as unknown as ActionRow | undefined;
    if (existing) {
      if (existing.owner_id !== ownerId) throw new Error("Reminder action belongs to a different Telegram owner.");
      return actionFromRow(existing);
    }
    const token = newToken();
    this.database.prepare(`INSERT INTO jarvis_notification_actions
      (token,source_kind,source_id,source_instance,owner_id,label,date_only,due_at,status,created_at)
      VALUES (?,'reminder',?,?,?,?,0,?,'pending',?)`).run(
      token, reminder.id, sourceInstance, ownerId, reminder.message, reminder.scheduledAt, now,
    );
    return {
      kind: "reminder",
      token,
      sourceId: reminder.id,
      sourceInstance,
      label: reminder.message,
      ownerId,
      dateOnly: false,
      dueAt: reminder.scheduledAt,
      taskRevision: null,
    };
  }

  claimRoutineAlert(now: string, ownerId: string): RoutineClaim | null {
    const instant = parseInstant(now);
    validateOwner(ownerId);
    const { hour, minute } = bogotaTime(instant);
    const totalMinutes = hour * 60 + minute;
    const isMorning = totalMinutes >= 6 * 60 + 30 && totalMinutes <= 11 * 60;
    const isNight = totalMinutes >= 21 * 60 + 30 && totalMinutes <= 23 * 60 + 59;
    if (!isMorning && !isNight) return null;

    const routineType: "morning" | "night" = isMorning ? "morning" : "night";
    const localDate = bogotaDate(instant);
    const sourceInstance = `${routineType}:${localDate}`;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT 1 FROM jarvis_notification_actions WHERE source_kind='reminder' AND source_id=0 AND source_instance=?",
      ).get(sourceInstance);
      if (existing) {
        this.database.exec("COMMIT");
        return null;
      }

      const token = newToken();
      const label = routineType === "morning"
        ? "☀️ Buenos días, Alex. Revisa prioridades y compromisos del día."
        : "🌙 Cierre de jornada. Revisa compromisos completados y registra el cierre diario.";

      this.database.prepare(`INSERT INTO jarvis_notification_actions
        (token,source_kind,source_id,source_instance,owner_id,label,date_only,due_at,status,created_at,task_revision)
        VALUES (?,'reminder',0,?,?,?,0,NULL,'pending',?,NULL)`).run(
        token,
        sourceInstance,
        ownerId,
        label,
        now,
      );
      this.database.exec("COMMIT");
      return {
        kind: "reminder",
        routineType,
        token,
        sourceId: 0,
        sourceInstance,
        label,
        ownerId,
        dateOnly: false,
        dueAt: null,
        taskRevision: null,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markUrgentSent(taskId: number, dueInstance: string, sentAt: string): void {
    this.database.prepare(`UPDATE jarvis_urgent_alerts SET status='sent',sent_at=?
      WHERE task_id=? AND due_instance=? AND status='dispatching'`).run(sentAt, taskId, dueInstance);
  }

  markUrgentReviewRequired(taskId: number, dueInstance: string): void {
    this.database.prepare(`UPDATE jarvis_urgent_alerts SET status='review_required'
      WHERE task_id=? AND due_instance=? AND status='dispatching'`).run(taskId, dueInstance);
  }

  quarantineInterruptedUrgentAlerts(): number {
    return Number(this.database.prepare(`UPDATE jarvis_urgent_alerts SET status='review_required'
      WHERE status='dispatching'`).run().changes);
  }

  getAction(token: string, ownerId: string): (NotificationActionRecord & { consumed: boolean }) | null {
    if (!isToken(token) || !/^[1-9][0-9]{5,19}$/.test(ownerId)) return null;
    const row = this.database.prepare("SELECT * FROM jarvis_notification_actions WHERE token=? AND owner_id=?")
      .get(token, ownerId) as unknown as ActionRow | undefined;
    return row ? { ...actionFromRow(row), consumed: row.status === "consumed" } : null;
  }

  markActionConsumed(token: string, action: NotificationAction, now: string): boolean {
    return this.database.prepare(`UPDATE jarvis_notification_actions
      SET status='consumed',consumed_at=?,consumed_action=?
      WHERE token=? AND status='pending'`).run(now, action, token).changes === 1;
  }

  private isWorkMode(): boolean {
    try {
      const table = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_mode_state'").get();
      if (!table) return false;
      const row = this.database.prepare("SELECT mode,goal FROM assistant_mode_state WHERE id=1").get() as { mode?: unknown; goal?: unknown } | undefined;
      return row?.mode === "work" && typeof row.goal === "string" && row.goal.trim().length > 0;
    } catch {
      return false;
    }
  }
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildNotificationPresentation(action: NotificationActionRecord): TelegramPresentation {
  const displayLabel = action.label.slice(0, 1200);
  const label = escapeTelegramHtml(displayLabel);
  const callback = (code: NotificationAction): string => {
    const data = `jarvis:n:${action.token}:${code}`;
    if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Telegram callback_data exceeds 64 bytes.");
    return data;
  };
  const buttons = [[
    { text: "✅ Hecho", callback_data: callback("d") },
    { text: "🎯 Modo trabajo", callback_data: callback("w") },
    { text: "⏰ En 1 hora", callback_data: callback("l") },
  ]];
  if (action.kind === "urgent") {
    const timing = action.dateOnly
      ? "La fecha límite es hoy; la hora no está definida."
      : `Vence ${formatBogota(action.dueAt!)}.`;
    return {
      html: `⚠️ <b>Fecha límite cercana</b>\n${label}\n${escapeTelegramHtml(timing)}`,
      plainText: `Fecha límite cercana\n${displayLabel}\n${timing}`,
      buttons,
    };
  }
  if (action.sourceInstance.startsWith("morning:")) {
    return {
      html: `☀️ <b>Buenos días, Alex</b>\n${label}`,
      plainText: `Buenos días, Alex\n${displayLabel}`,
      buttons: [[
        { text: "✅ Iniciar día", callback_data: callback("d") },
        { text: "🎯 Modo trabajo", callback_data: callback("w") },
        { text: "⏰ En 1 hora", callback_data: callback("l") },
      ]],
    };
  }
  if (action.sourceInstance.startsWith("night:")) {
    return {
      html: `🌙 <b>Cierre de jornada</b>\n${label}`,
      plainText: `Cierre de jornada\n${displayLabel}`,
      buttons: [[
        { text: "✅ Confirmar cierre", callback_data: callback("d") },
        { text: "🎯 Modo trabajo", callback_data: callback("w") },
        { text: "⏰ En 1 hora", callback_data: callback("l") },
      ]],
    };
  }
  if (action.label.includes("Fin de bloque de foco") || action.sourceInstance.startsWith("focus:")) {
    return {
      html: `⏰ <b>Tiempo cumplido de foco (45 min)</b>\n${label}\n\nProtocolo de descanso:\n• Levántate de la silla y toma agua.\n• Cero redes sociales ni celular en el descanso.`,
      plainText: `Tiempo cumplido de foco (45 min)\n${displayLabel}\nDescanso de 10 minutos.`,
      buttons: [[
        { text: "✅ Bloque completado", callback_data: callback("d") },
        { text: "⏳ 15m más", callback_data: callback("l") },
        { text: "🛋️ Terminar sesión", callback_data: callback("w") },
      ]],
    };
  }
  return {
    html: `⏰ <b>Recordatorio</b>\n${label}`,
    plainText: `Recordatorio\n${displayLabel}`,
    buttons,
  };
}

export async function sendTelegramPresentation(
  fetcher: TelegramFetch,
  endpoint: string,
  ownerId: string,
  presentation: TelegramPresentation,
): Promise<void> {
  validateOwner(ownerId);
  const post = (body: Record<string, unknown>) => fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await post({
    chat_id: ownerId,
    text: presentation.html,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: presentation.buttons },
  });
  if (!response.ok) {
    if (response.status !== 400) throw new Error(`Telegram notification delivery returned status ${response.status}.`);
    const fallback = await post({ chat_id: ownerId, text: presentation.plainText });
    if (!fallback.ok) throw new Error(`Telegram notification fallback returned status ${fallback.status}.`);
    const fallbackPayload = await fallback.json() as { ok?: unknown };
    if (fallbackPayload.ok !== true) throw new Error("Telegram notification fallback was not acknowledged.");
    return;
  }
  const payload = await response.json() as { ok?: unknown };
  if (payload.ok !== true) throw new Error("Telegram notification delivery was not acknowledged.");
}

interface InteractiveContext {
  senderId?: string;
  isGroup: boolean;
  auth: { isAuthorizedSender: boolean };
  callback: { payload: string; chatId: string };
  respond: {
    editMessage: (params: { text: string; buttons?: Array<Array<{ text: string; callback_data: string }>> }) => Promise<void>;
    clearButtons: () => Promise<void>;
  };
}

export async function handleJarvisCallback(
  context: InteractiveContext,
  deps: { databasePath: string; ownerId: string; now?: () => Date },
): Promise<{ handled: true }> {
  const authorized = context.auth.isAuthorizedSender
    && !context.isGroup
    && context.senderId === deps.ownerId
    && context.callback.chatId === deps.ownerId;
  if (!authorized) return { handled: true };
  const parsed = /^n:([A-Za-z0-9_-]{16}):([dwl])$/.exec(context.callback.payload);
  if (!parsed) {
    await context.respond.clearButtons();
    return { handled: true };
  }
  const token = parsed[1]!;
  const action = parsed[2]! as NotificationAction;
  const notifications = new NotificationStore(deps.databasePath);
  try {
    const record = notifications.getAction(token, deps.ownerId);
    if (!record) {
      await context.respond.clearButtons();
      return { handled: true };
    }
    if (record.consumed) {
      await context.respond.editMessage({ text: "Esta acción ya fue procesada.", buttons: [] });
      return { handled: true };
    }
    const now = (deps.now ?? (() => new Date()))();
    if (action === "d") {
      if (record.kind === "urgent") {
        const rejectStale = async () => {
          await context.respond.editMessage({ text: "Este botón no corresponde a una versión vigente de la tarea. Revisa tus pendientes para marcarla como hecha.", buttons: [] });
        };
        if (!Number.isSafeInteger(record.taskRevision) || record.taskRevision === null || record.taskRevision < 1) {
          await rejectStale();
          return { handled: true };
        }
        const legacy = new LegacyStore(deps.databasePath);
        try {
          legacy.completeTask(record.sourceId, undefined, { expectedRevision: record.taskRevision, idempotencyKey: `notification:${token}:done` });
        } catch (error) {
          if (!(error instanceof Error) || !/Task revision conflict|Task is not available/u.test(error.message)) throw error;
          await rejectStale();
          return { handled: true };
        } finally { legacy.close(); }
      } else if (record.sourceInstance.startsWith("night:")) {
        const coaching = new CoachingStore(deps.databasePath, () => now);
        try {
          const localDate = record.sourceInstance.slice("night:".length);
          coaching.recordDayClose({
            localDate,
            criticalCommitmentsComplete: true,
            dailyCloseComplete: true,
            sourceSystem: "telegram-interactive",
            idempotencyKey: `notification:${token}:close`,
          });
        } finally {
          coaching.close();
        }
      } else if (record.label.includes("Fin de bloque de foco") || record.sourceInstance.startsWith("focus:")) {
        const coaching = new CoachingStore(deps.databasePath, () => now);
        try {
          coaching.recordCheckIn({
            kind: "study",
            occurredAt: now.toISOString(),
            evidence: record.label.slice(0, 500),
            sourceSystem: "telegram-interactive",
            idempotencyKey: `notification:${token}:focus`,
          });
        } finally {
          coaching.close();
        }
        const legacy = new LegacyStore(deps.databasePath);
        try {
          legacy.createReminder({
            message: "☕ Pausa de 10 minutos finalizada. ¿Listo para el siguiente bloque o cerramos sesión?",
            scheduledAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
            sourceSystem: "jarvis-focus-break",
            legacyId: `break:${token}`,
          });
        } finally {
          legacy.close();
        }
      }
    } else if (action === "w") {
      const mode = new AssistantModeStore(deps.databasePath, () => now);
      try {
        if (record.label.includes("Fin de bloque de foco") || record.sourceInstance.startsWith("focus:")) {
          mode.set({ mode: "normal", sourceSystem: "telegram-interactive", idempotencyKey: `notification:${token}:exit` });
        } else {
          const goal = record.sourceInstance.startsWith("morning:")
            ? "Foco y metas del día"
            : record.sourceInstance.startsWith("night:")
              ? "Cerrar compromisos pendientes"
              : record.label.slice(0, 240);
          mode.set({ mode: "work", goal, sourceSystem: "telegram-interactive", idempotencyKey: `notification:${token}:work` });
        }
      } finally {
        mode.close();
      }
    } else {
      const legacy = new LegacyStore(deps.databasePath);
      try {
        const isFocus = record.label.includes("Fin de bloque de foco") || record.sourceInstance.startsWith("focus:");
        const scheduledAt = isFocus
          ? new Date(now.getTime() + 15 * 60 * 1000).toISOString()
          : new Date(now.getTime() + 60 * 60 * 1000).toISOString();
        legacy.createReminder({
          message: record.label,
          scheduledAt,
          sourceSystem: isFocus ? "jarvis-focus-extend" : "jarvis-notification",
          legacyId: `later:${token}`,
        });
      } finally {
        legacy.close();
      }
    }
    notifications.markActionConsumed(token, action, now.toISOString());
    const isFocus = record.label.includes("Fin de bloque de foco") || record.sourceInstance.startsWith("focus:");
    const result = action === "d"
      ? record.sourceInstance.startsWith("night:")
        ? "🌙 ¡Cierre diario registrado con éxito! Rachas actualizadas."
        : record.sourceInstance.startsWith("morning:")
          ? "☀️ ¡Excelente! Jornada iniciada con foco."
          : isFocus
            ? "☕ ¡Excelente bloque de 45 minutos completado! Racha de estudio registrada. Tienes 10 minutos de pausa activa sin pantallas."
            : "Listo, quedó hecho."
      : action === "w"
        ? isFocus
          ? "🛋️ Sesión de foco terminada. Modo normal restablecido. Buen trabajo Alex."
          : "Modo trabajo activado."
        : isFocus
          ? "⏳ 15 minutos adicionales de foco activados. ¡A dar el último empujón!"
          : "Te lo recordaré en una hora.";
    await context.respond.editMessage({ text: result, buttons: [] });
    return { handled: true };
  } finally {
    notifications.close();
  }
}

function urgentCandidate(row: TaskRow, now: number, horizon: number, localDate: string) {
  if (row.due_at) {
    const due = Date.parse(row.due_at);
    if (!Number.isFinite(due) || due <= now || due > horizon) return null;
    return { row, dueInstance: `at:${row.due_at}`, dateOnly: false, dueAt: row.due_at, sortAt: due };
  }
  if (row.due_date !== localDate) return null;
  return { row, dueInstance: `date:${row.due_date}`, dateOnly: true, dueAt: null, sortAt: now };
}

function taskFromRow(row: TaskRow): NotificationTaskSnapshot {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    dueDate: row.due_date,
    dueAt: row.due_at,
    status: row.status,
    completedAt: row.completed_at,
    sourceSystem: row.source_system,
    legacyId: row.legacy_id,
    sourceHash: row.source_hash,
    importedAt: row.imported_at,
  };
}

function actionFromRow(row: ActionRow): NotificationActionRecord {
  return {
    kind: row.source_kind,
    token: row.token,
    sourceId: row.source_id,
    sourceInstance: row.source_instance,
    label: row.label,
    ownerId: row.owner_id,
    dateOnly: row.date_only === 1,
    dueAt: row.due_at,
    taskRevision: row.task_revision ?? null,
  };
}

function parseInstant(value: string): Date {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Notification time is invalid.");
  return new Date(timestamp);
}

function validateOwner(value: string): void {
  if (!/^[1-9][0-9]{5,19}$/.test(value)) throw new Error("Telegram owner ID is invalid.");
}

function bogotaDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function bogotaTime(value: Date): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(value);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour: hour === 24 ? 0 : hour, minute };
}

function formatBogota(value: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parseInstant(value));
}

function newToken(): string {
  return randomBytes(12).toString("base64url");
}

function isToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16}$/.test(value);
}
