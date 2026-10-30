import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type SalesStage = "researched" | "contacted" | "conversation" | "diagnosis" | "won" | "lost";
export type SalesOutcome = Exclude<SalesStage, "researched">;

export interface Prospect {
  id: string;
  companyName: string;
  contactName: string;
  contactChannel: string;
  source: string;
  stage: SalesStage;
  createdAt: string;
}

export interface SalesMetrics {
  prospectsCreated: number;
  contacted: number;
  conversations: number;
  diagnoses: number;
  won: number;
  contractedCents: number;
}

interface ProspectRow {
  id: string;
  company_name: string;
  contact_name: string;
  contact_channel: string;
  source: string;
  stage: SalesStage;
  created_at: string;
}

interface CountRow { count: number }
interface SumRow { total: number | null }

export class SalesStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prospects (
        id TEXT PRIMARY KEY,
        company_name TEXT NOT NULL,
        company_key TEXT NOT NULL UNIQUE,
        contact_name TEXT NOT NULL,
        contact_channel TEXT NOT NULL,
        source TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('researched','contacted','conversation','diagnosis','won','lost')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales_outcomes (
        id TEXT PRIMARY KEY,
        prospect_id TEXT NOT NULL REFERENCES prospects(id),
        outcome TEXT NOT NULL CHECK(outcome IN ('contacted','conversation','diagnosis','won','lost')),
        occurred_at TEXT NOT NULL,
        contracted_cents INTEGER,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS sales_outcomes_at_idx ON sales_outcomes(occurred_at);
    `);
  }

  createProspect(input: {
    companyName: string;
    contactName: string;
    contactChannel: string;
    source: string;
  }): Prospect {
    const companyName = requireText(input.companyName, "companyName", 160);
    const prospect: Prospect = {
      id: randomUUID(),
      companyName,
      contactName: requireText(input.contactName, "contactName", 120),
      contactChannel: requireText(input.contactChannel, "contactChannel", 120),
      source: requireText(input.source, "source", 120),
      stage: "researched",
      createdAt: this.now().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO prospects (id, company_name, company_key, contact_name, contact_channel, source, stage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prospect.id,
      prospect.companyName,
      normalizeCompanyKey(prospect.companyName),
      prospect.contactName,
      prospect.contactChannel,
      prospect.source,
      prospect.stage,
      prospect.createdAt,
    );
    return prospect;
  }

  getProspect(id: string): Prospect {
    const row = this.db.prepare("SELECT * FROM prospects WHERE id = ?").get(id) as unknown as ProspectRow | undefined;
    if (!row) throw new Error("Prospect not found.");
    return mapProspect(row);
  }

  prepareOutreach(prospectId: string): { prospectId: string; requiresApproval: true; message: string } {
    const prospect = this.getProspect(prospectId);
    return {
      prospectId,
      requiresApproval: true,
      message: `Hola ${prospect.contactName}, estoy ayudando a empresas como ${prospect.companyName} a reducir el tiempo que pierden atendiendo consultas y cotizaciones repetitivas por WhatsApp. ¿Te parece si revisamos el proceso durante 15 minutos y te digo si vale la pena automatizarlo?`,
    };
  }

  recordOutcome(input: {
    prospectId: string;
    outcome: SalesOutcome;
    occurredAt?: string;
    contractedCents?: number;
    note?: string;
  }): Prospect {
    this.getProspect(input.prospectId);
    const occurredAt = input.occurredAt ?? this.now().toISOString();
    if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("occurredAt must be an ISO timestamp.");
    if (input.outcome === "won" && (!Number.isInteger(input.contractedCents) || (input.contractedCents ?? 0) <= 0)) {
      throw new Error("Won outcomes require a positive contractedCents value.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO sales_outcomes (id, prospect_id, outcome, occurred_at, contracted_cents, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), input.prospectId, input.outcome, occurredAt, input.contractedCents ?? null, input.note ?? null);
      this.db.prepare("UPDATE prospects SET stage = ? WHERE id = ?").run(input.outcome, input.prospectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProspect(input.prospectId);
  }

  metrics30Days(asOf: string): SalesMetrics {
    const asOfMs = Date.parse(asOf);
    if (!Number.isFinite(asOfMs)) throw new Error("asOf must be an ISO timestamp.");
    const start = new Date(asOfMs - 30 * 86_400_000).toISOString();
    const countProspects = this.db.prepare(
      "SELECT COUNT(*) AS count FROM prospects WHERE created_at >= ? AND created_at <= ?",
    ).get(start, asOf) as unknown as CountRow;
    const countOutcome = (outcome: SalesOutcome): number => {
      const row = this.db.prepare(
        "SELECT COUNT(DISTINCT prospect_id) AS count FROM sales_outcomes WHERE outcome = ? AND occurred_at >= ? AND occurred_at <= ?",
      ).get(outcome, start, asOf) as unknown as CountRow;
      return row.count;
    };
    const contracted = this.db.prepare(
      "SELECT COALESCE(SUM(contracted_cents), 0) AS total FROM sales_outcomes WHERE outcome = 'won' AND occurred_at >= ? AND occurred_at <= ?",
    ).get(start, asOf) as unknown as SumRow;
    return {
      prospectsCreated: countProspects.count,
      contacted: countOutcome("contacted"),
      conversations: countOutcome("conversation"),
      diagnoses: countOutcome("diagnosis"),
      won: countOutcome("won"),
      contractedCents: contracted.total ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

function requireText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  return trimmed;
}

function normalizeCompanyKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-CO");
}

function mapProspect(row: ProspectRow): Prospect {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name,
    contactChannel: row.contact_channel,
    source: row.source,
    stage: row.stage,
    createdAt: row.created_at,
  };
}
