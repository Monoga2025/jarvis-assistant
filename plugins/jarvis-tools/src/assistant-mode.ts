import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type AssistantMode = "normal" | "work";

export interface AssistantModeState {
  mode: AssistantMode;
  goal: string | null;
  updatedAt: string;
}

interface StateRow { mode: string; goal: string | null; updated_at: string }
interface AuditRow { id: string; request_hash: string; resulting_state_json: string }

export class AssistantModeStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => Date = () => new Date()) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS assistant_mode_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        mode TEXT NOT NULL CHECK(mode IN ('normal','work')),
        goal TEXT,
        updated_at TEXT NOT NULL,
        CHECK((mode='normal' AND goal IS NULL) OR (mode='work' AND goal IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS assistant_mode_audit (
        id TEXT PRIMARY KEY,
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        requested_mode TEXT NOT NULL,
        requested_goal TEXT,
        resulting_state_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(source_system,idempotency_key)
      );
    `);
    this.database.prepare("INSERT OR IGNORE INTO assistant_mode_state (id,mode,goal,updated_at) VALUES (1,'normal',NULL,?)")
      .run(this.now().toISOString());
  }

  close(): void { this.database.close(); }

  get(): AssistantModeState {
    try {
      const row = this.database.prepare("SELECT mode,goal,updated_at FROM assistant_mode_state WHERE id=1").get() as unknown as StateRow | undefined;
      if (!row || (row.mode !== "normal" && row.mode !== "work")) return this.normalFallback();
      if (row.mode === "normal") return { mode: "normal", goal: null, updatedAt: row.updated_at };
      const goal = normalizeGoal(row.goal ?? "");
      if (!goal) return this.normalFallback();
      return { mode: "work", goal, updatedAt: row.updated_at };
    } catch {
      return this.normalFallback();
    }
  }

  set(input: {
    mode: AssistantMode;
    goal?: string;
    sourceSystem: string;
    idempotencyKey: string;
  }): AssistantModeState {
    const sourceSystem = bounded(input.sourceSystem, "sourceSystem", 120);
    const idempotencyKey = bounded(input.idempotencyKey, "idempotencyKey", 200);
    const goal = input.mode === "work" ? normalizeGoal(input.goal ?? "") : null;
    if (input.mode === "work" && !goal) throw new Error("A work-mode goal is required.");
    const content = { mode: input.mode, goal };
    const requestHash = hash(content);
    const recordedAt = this.now().toISOString();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT id,request_hash,resulting_state_json FROM assistant_mode_audit WHERE source_system=? AND idempotency_key=?")
        .get(sourceSystem, idempotencyKey) as unknown as AuditRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("Assistant mode idempotency key was reused with different content.");
        const result = parseStoredState(existing.resulting_state_json);
        this.database.exec("COMMIT");
        return result;
      }

      this.database.prepare("UPDATE assistant_mode_state SET mode=?,goal=?,updated_at=? WHERE id=1")
        .run(input.mode, goal, recordedAt);
      const result: AssistantModeState = { mode: input.mode, goal, updatedAt: recordedAt };
      this.database.prepare(`INSERT INTO assistant_mode_audit
        (id,source_system,idempotency_key,request_hash,requested_mode,requested_goal,resulting_state_json,recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        randomUUID(), sourceSystem, idempotencyKey, requestHash, input.mode, goal, JSON.stringify(result), recordedAt,
      );
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private normalFallback(): AssistantModeState {
    return { mode: "normal", goal: null, updatedAt: this.now().toISOString() };
  }
}

export function assistantModePrompt(state: AssistantModeState): string {
  if (state.mode === "work") {
    return `MODE_WORK. Objetivo actual: ${state.goal}. Podés ser directivo, dividir el objetivo y hacer seguimiento. Indicá que Alex puede salir del modo trabajo con lenguaje natural, por ejemplo “salgamos del modo trabajo”.`;
  }
  return "MODE_NORMAL. Sos un asistente personal y segundo cerebro amable. Respondé primero a lo que Alex pidió; no ordenes ni fuerces trabajo, no impongas planes ni inventes una siguiente acción. Activá MODE_WORK únicamente ante intención explícita en lenguaje natural como “modo trabajo”, “vamos a estudiar” o “necesito concentrarme”.";
}

function normalizeGoal(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length > 240) throw new Error("Work-mode goal must contain at most 240 characters.");
  return normalized;
}

function bounded(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} must contain between 1 and ${maxLength} characters.`);
  return normalized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseStoredState(value: string): AssistantModeState {
  const parsed = JSON.parse(value) as Partial<AssistantModeState>;
  if ((parsed.mode !== "normal" && parsed.mode !== "work") || typeof parsed.updatedAt !== "string") {
    throw new Error("Stored assistant mode audit result is invalid.");
  }
  if (parsed.mode === "normal") return { mode: "normal", goal: null, updatedAt: parsed.updatedAt };
  const goal = normalizeGoal(parsed.goal ?? "");
  if (!goal) throw new Error("Stored work-mode audit result has no goal.");
  return { mode: "work", goal, updatedAt: parsed.updatedAt };
}
