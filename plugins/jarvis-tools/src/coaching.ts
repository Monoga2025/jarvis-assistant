import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalDate, canonicalInstant } from "./date-time.js";

export const CHECK_IN_KINDS = ["study", "gym", "meal_prep", "deep_work"] as const;
export type CheckInKind = (typeof CHECK_IN_KINDS)[number];

export interface CheckInInput {
  kind: CheckInKind;
  occurredAt: string;
  evidence: string;
  sourceSystem: string;
  idempotencyKey: string;
}

export interface DayCloseInput {
  localDate: string;
  criticalCommitmentsComplete: boolean;
  dailyCloseComplete: boolean;
  sourceSystem: string;
  idempotencyKey: string;
}

export interface CoachingSummary {
  localDate: string;
  weekStart: string;
  consistency: Record<CheckInKind, { currentWeek: number; currentStreakDays: number }>;
  reward: {
    eligible: boolean;
    gamingMinutes: 0 | 45;
    suggestion: string | null;
    reason: "eligible" | "daily_close_incomplete" | "critical_commitments_incomplete" | "productive_checkin_missing";
  };
}

interface ExistingRow { id: string; request_hash: string }
interface CheckInRow { kind: CheckInKind; local_date: string }
interface CloseRow { critical_commitments_complete: number; daily_close_complete: number }
interface CoachStateRow { enabled: number }
interface ClaimRow { claimed_at: string }

const COACH_COOLDOWN_MINUTES = 180;

export class CoachingStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => Date = () => new Date()) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS coaching_checkins (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('study','gym','meal_prep','deep_work')),
        local_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        evidence TEXT NOT NULL,
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(source_system, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS coaching_checkins_date_kind ON coaching_checkins(local_date,kind);
      CREATE TABLE IF NOT EXISTS coaching_day_closes (
        id TEXT PRIMARY KEY,
        local_date TEXT NOT NULL,
        critical_commitments_complete INTEGER NOT NULL CHECK(critical_commitments_complete IN (0,1)),
        daily_close_complete INTEGER NOT NULL CHECK(daily_close_complete IN (0,1)),
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(source_system, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS coaching_day_closes_date ON coaching_day_closes(local_date,recorded_at);
      CREATE TABLE IF NOT EXISTS coaching_state (
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coaching_proactive_claims (
        signature TEXT PRIMARY KEY,
        claimed_at TEXT NOT NULL
      );
    `);
    this.database.prepare("INSERT OR IGNORE INTO coaching_state (id,enabled,updated_at) VALUES (1,1,?)")
      .run("2026-09-06T00:00:00.000Z");
  }

  close(): void {
    this.database.close();
  }

  recordCheckIn(input: CheckInInput): { id: string; replayed: boolean } {
    const occurredAt = canonicalInstant(input.occurredAt, "occurredAt");
    const content = {
      kind: checkInKind(input.kind),
      occurredAt,
      localDate: bogotaDate(new Date(occurredAt)),
      evidence: text(input.evidence, "evidence", 500),
      sourceSystem: text(input.sourceSystem, "sourceSystem", 120),
      idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 200),
    };
    return this.insertIdempotent(
      "coaching_checkins",
      `INSERT OR IGNORE INTO coaching_checkins
        (id,kind,local_date,occurred_at,evidence,source_system,idempotency_key,request_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [content.kind, content.localDate, content.occurredAt, content.evidence],
      content,
      content.sourceSystem,
      content.idempotencyKey,
      "Check-in",
    );
  }

  recordDayClose(input: DayCloseInput): { id: string; replayed: boolean } {
    const content = {
      localDate: canonicalDate(input.localDate, "localDate"),
      criticalCommitmentsComplete: Boolean(input.criticalCommitmentsComplete),
      dailyCloseComplete: Boolean(input.dailyCloseComplete),
      sourceSystem: text(input.sourceSystem, "sourceSystem", 120),
      idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 200),
    };
    return this.insertIdempotent(
      "coaching_day_closes",
      `INSERT OR IGNORE INTO coaching_day_closes
        (id,local_date,critical_commitments_complete,daily_close_complete,source_system,idempotency_key,request_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      [content.localDate, Number(content.criticalCommitmentsComplete), Number(content.dailyCloseComplete)],
      content,
      content.sourceSystem,
      content.idempotencyKey,
      "Daily close",
    );
  }

  summary(asOf = this.now().toISOString()): CoachingSummary {
    const instant = new Date(canonicalInstant(asOf, "asOf"));
    const today = bogotaDate(instant);
    const weekStart = mondayOf(today);
    const rows = this.database.prepare("SELECT kind,local_date FROM coaching_checkins WHERE local_date>=? AND local_date<=? ORDER BY local_date")
      .all(weekStart, today) as unknown as CheckInRow[];
    const allRows = this.database.prepare("SELECT kind,local_date FROM coaching_checkins WHERE local_date<=? ORDER BY local_date DESC")
      .all(today) as unknown as CheckInRow[];
    const consistency = Object.fromEntries(CHECK_IN_KINDS.map((kind) => {
      const dates = new Set(allRows.filter((row) => row.kind === kind).map((row) => row.local_date));
      let cursor = today;
      let currentStreakDays = 0;
      while (dates.has(cursor)) {
        currentStreakDays += 1;
        cursor = previousDate(cursor);
      }
      return [kind, { currentWeek: rows.filter((row) => row.kind === kind).length, currentStreakDays }];
    })) as CoachingSummary["consistency"];

    const close = this.database.prepare(`SELECT critical_commitments_complete,daily_close_complete FROM coaching_day_closes
      WHERE local_date=? ORDER BY recorded_at DESC,id DESC LIMIT 1`).get(today) as unknown as CloseRow | undefined;
    const productive = rows.some((row) => row.local_date === today && (row.kind === "study" || row.kind === "deep_work"));
    const reason = !close?.daily_close_complete
      ? "daily_close_incomplete"
      : !close.critical_commitments_complete
        ? "critical_commitments_incomplete"
        : !productive
          ? "productive_checkin_missing"
          : "eligible";
    const eligible = reason === "eligible";
    return {
      localDate: today,
      weekStart,
      consistency,
      reward: {
        eligible,
        gamingMinutes: eligible ? 45 : 0,
        suggestion: eligible ? "You may choose up to 45 minutes of gaming after the completed daily close." : null,
        reason,
      },
    };
  }

  coachStatus(): { enabled: boolean; cooldownMinutes: 180; lastClaimedAt: string | null } {
    const state = this.database.prepare("SELECT enabled FROM coaching_state WHERE id=1").get() as unknown as CoachStateRow;
    const latest = this.database.prepare("SELECT claimed_at FROM coaching_proactive_claims ORDER BY claimed_at DESC LIMIT 1").get() as unknown as ClaimRow | undefined;
    return { enabled: state.enabled === 1, cooldownMinutes: COACH_COOLDOWN_MINUTES, lastClaimedAt: latest?.claimed_at ?? null };
  }

  setCoachEnabled(enabled: boolean): void {
    this.database.prepare("UPDATE coaching_state SET enabled=?,updated_at=? WHERE id=1").run(Number(enabled), this.now().toISOString());
  }

  claimProactive(signatureInput: string): { shouldSend: boolean; reason: "claimed" | "duplicate" | "cooldown" | "disabled" } {
    const signature = text(signatureInput, "signature", 200);
    const claimedAt = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.coachStatus();
      if (!state.enabled) {
        this.database.exec("COMMIT");
        return { shouldSend: false, reason: "disabled" };
      }
      const duplicate = this.database.prepare("SELECT claimed_at FROM coaching_proactive_claims WHERE signature=?").get(signature) as unknown as ClaimRow | undefined;
      if (duplicate) {
        this.database.exec("COMMIT");
        return { shouldSend: false, reason: "duplicate" };
      }
      if (state.lastClaimedAt && Date.parse(claimedAt) - Date.parse(state.lastClaimedAt) < COACH_COOLDOWN_MINUTES * 60_000) {
        this.database.exec("COMMIT");
        return { shouldSend: false, reason: "cooldown" };
      }
      this.database.prepare("INSERT INTO coaching_proactive_claims (signature,claimed_at) VALUES (?,?)").run(signature, claimedAt);
      this.database.exec("COMMIT");
      return { shouldSend: true, reason: "claimed" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertIdempotent(
    table: "coaching_checkins" | "coaching_day_closes",
    sql: string,
    businessValues: Array<string | number>,
    content: unknown,
    sourceSystem: string,
    idempotencyKey: string,
    label: string,
  ): { id: string; replayed: boolean } {
    const id = randomUUID();
    const requestHash = hash(content);
    const recordedAt = this.now().toISOString();
    const inserted = this.database.prepare(sql).run(id, ...businessValues, sourceSystem, idempotencyKey, requestHash, recordedAt);
    const existing = this.database.prepare(`SELECT id,request_hash FROM ${table} WHERE source_system=? AND idempotency_key=?`)
      .get(sourceSystem, idempotencyKey) as unknown as ExistingRow | undefined;
    if (!existing) throw new Error(`${label} could not be stored.`);
    if (existing.request_hash !== requestHash) throw new Error(`${label} idempotency key was reused with different content.`);
    return { id: existing.id, replayed: inserted.changes === 0 };
  }
}

function checkInKind(value: string): CheckInKind {
  if (!CHECK_IN_KINDS.includes(value as CheckInKind)) throw new Error("Unsupported check-in kind.");
  return value as CheckInKind;
}

function text(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  return normalized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bogotaDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function mondayOf(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const daysFromMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysFromMonday);
  return value.toISOString().slice(0, 10);
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}
