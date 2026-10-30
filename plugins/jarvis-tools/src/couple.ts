import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalDate } from "./date-time.js";

export type CouplePartyId = "alex" | "sam";
export type ConsentStatus = "active" | "pending";

export interface CoupleParty {
  id: CouplePartyId;
  displayName: string;
  role: "owner" | "partner";
  consentStatus: ConsentStatus;
  bankStatementConsent: ConsentStatus;
}

export interface ExpenseAllocationInput {
  partyId: CouplePartyId;
  amountCop: number;
}

export interface SharedExpenseInput {
  description: string;
  amountCop: number;
  incurredOn: string;
  paidByPartyId: CouplePartyId;
  allocations: ExpenseAllocationInput[];
  sourceSystem: string;
  idempotencyKey: string;
}

export interface SettlementInput {
  fromPartyId: CouplePartyId;
  toPartyId: CouplePartyId;
  amountCop: number;
  occurredOn: string;
  note?: string;
  sourceSystem: string;
  idempotencyKey: string;
}

export interface CoupleSummary {
  parties: CoupleParty[];
  spendingCop: number;
  incomeCop: 0;
  settlementsCop: number;
  expenseCount: number;
  settlementCount: number;
  auditEventCount: number;
  balances: Array<{ partyId: CouplePartyId; balanceCop: number }>;
}

interface PartyRow {
  id: CouplePartyId;
  display_name: string;
  role: "owner" | "partner";
  consent_status: ConsentStatus;
  bank_statement_consent: ConsentStatus;
}

interface ExistingRow { id: string; request_hash: string }
interface ExpenseRow { id: string; amount_cop: number; paid_by_party_id: CouplePartyId }
interface AllocationRow { party_id: CouplePartyId; amount_cop: number }
interface SettlementRow { from_party_id: CouplePartyId; to_party_id: CouplePartyId; amount_cop: number }
interface CountRow { count: number }

export class CoupleStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => Date = () => new Date()) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS couple_parties (
        id TEXT PRIMARY KEY CHECK(id IN ('alex','sam')),
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','partner')),
        consent_status TEXT NOT NULL CHECK(consent_status IN ('active','pending')),
        bank_statement_consent TEXT NOT NULL CHECK(bank_statement_consent IN ('active','pending')),
        source_system TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS couple_expenses (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        amount_cop INTEGER NOT NULL CHECK(typeof(amount_cop)='integer' AND amount_cop > 0),
        incurred_on TEXT NOT NULL,
        paid_by_party_id TEXT NOT NULL REFERENCES couple_parties(id),
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(source_system, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS couple_expense_allocations (
        expense_id TEXT NOT NULL REFERENCES couple_expenses(id),
        party_id TEXT NOT NULL REFERENCES couple_parties(id),
        amount_cop INTEGER NOT NULL CHECK(typeof(amount_cop)='integer' AND amount_cop > 0),
        PRIMARY KEY(expense_id, party_id)
      );
      CREATE TABLE IF NOT EXISTS couple_settlements (
        id TEXT PRIMARY KEY,
        from_party_id TEXT NOT NULL REFERENCES couple_parties(id),
        to_party_id TEXT NOT NULL REFERENCES couple_parties(id),
        amount_cop INTEGER NOT NULL CHECK(typeof(amount_cop)='integer' AND amount_cop > 0),
        occurred_on TEXT NOT NULL,
        note TEXT,
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        CHECK(from_party_id <> to_party_id),
        UNIQUE(source_system, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS couple_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK(event_type IN ('shared_expense_recorded','settlement_recorded')),
        entity_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE(event_type, source_system, idempotency_key)
      );
      CREATE TRIGGER IF NOT EXISTS couple_audit_no_update
        BEFORE UPDATE ON couple_audit_events BEGIN SELECT RAISE(ABORT, 'couple audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS couple_audit_no_delete
        BEFORE DELETE ON couple_audit_events BEGIN SELECT RAISE(ABORT, 'couple audit is append-only'); END;
    `);
    this.seedParties();
  }

  close(): void {
    this.database.close();
  }

  listParties(): CoupleParty[] {
    const rows = this.database.prepare("SELECT id,display_name,role,consent_status,bank_statement_consent FROM couple_parties ORDER BY CASE id WHEN 'alex' THEN 0 ELSE 1 END").all() as unknown as PartyRow[];
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      consentStatus: row.consent_status,
      bankStatementConsent: row.bank_statement_consent,
    }));
  }

  assertBankStatementImportAllowed(partyId: CouplePartyId): void {
    const party = this.getParty(partyId);
    if (party.consentStatus !== "active" || party.bankStatementConsent !== "active") {
      throw new Error(`${party.displayName} must personally grant scoped consent before any bank statement import.`);
    }
  }

  recordSharedExpense(input: SharedExpenseInput): { id: string; replayed: boolean } {
    const content = normalizeExpense(input);
    this.getParty(content.paidByPartyId);
    for (const allocation of content.allocations) this.getParty(allocation.partyId);
    const requestHash = hash(content);
    const id = randomUUID();
    const recordedAt = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO couple_expenses
        (id,description,amount_cop,incurred_on,paid_by_party_id,source_system,idempotency_key,request_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        id, content.description, content.amountCop, content.incurredOn, content.paidByPartyId,
        content.sourceSystem, content.idempotencyKey, requestHash, recordedAt,
      );
      const existing = this.database.prepare("SELECT id,request_hash FROM couple_expenses WHERE source_system=? AND idempotency_key=?")
        .get(content.sourceSystem, content.idempotencyKey) as unknown as ExistingRow | undefined;
      if (!existing) throw new Error("Shared expense could not be stored.");
      if (existing.request_hash !== requestHash) throw new Error("Shared expense idempotency key was reused with different content.");
      if (inserted.changes === 1) {
        const allocationStatement = this.database.prepare("INSERT INTO couple_expense_allocations (expense_id,party_id,amount_cop) VALUES (?,?,?)");
        for (const allocation of content.allocations) allocationStatement.run(existing.id, allocation.partyId, allocation.amountCop);
        this.recordAudit("shared_expense_recorded", existing.id, requestHash, content.sourceSystem, content.idempotencyKey, recordedAt);
      }
      this.database.exec("COMMIT");
      return { id: existing.id, replayed: inserted.changes === 0 };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordSettlement(input: SettlementInput): { id: string; replayed: boolean } {
    const content = normalizeSettlement(input);
    this.getParty(content.fromPartyId);
    this.getParty(content.toPartyId);
    const requestHash = hash(content);
    const id = randomUUID();
    const recordedAt = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO couple_settlements
        (id,from_party_id,to_party_id,amount_cop,occurred_on,note,source_system,idempotency_key,request_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, content.fromPartyId, content.toPartyId, content.amountCop, content.occurredOn, content.note,
        content.sourceSystem, content.idempotencyKey, requestHash, recordedAt,
      );
      const existing = this.database.prepare("SELECT id,request_hash FROM couple_settlements WHERE source_system=? AND idempotency_key=?")
        .get(content.sourceSystem, content.idempotencyKey) as unknown as ExistingRow | undefined;
      if (!existing) throw new Error("Settlement could not be stored.");
      if (existing.request_hash !== requestHash) throw new Error("Settlement idempotency key was reused with different content.");
      if (inserted.changes === 1) this.recordAudit("settlement_recorded", existing.id, requestHash, content.sourceSystem, content.idempotencyKey, recordedAt);
      this.database.exec("COMMIT");
      return { id: existing.id, replayed: inserted.changes === 0 };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  summary(): CoupleSummary {
    const balances = new Map<CouplePartyId, number>(this.listParties().map((party) => [party.id, 0]));
    const expenses = this.database.prepare("SELECT id,amount_cop,paid_by_party_id FROM couple_expenses ORDER BY recorded_at,id").all() as unknown as ExpenseRow[];
    let spendingCop = 0;
    for (const expense of expenses) {
      spendingCop += expense.amount_cop;
      balances.set(expense.paid_by_party_id, (balances.get(expense.paid_by_party_id) ?? 0) - expense.amount_cop);
      const allocations = this.database.prepare("SELECT party_id,amount_cop FROM couple_expense_allocations WHERE expense_id=? ORDER BY party_id")
        .all(expense.id) as unknown as AllocationRow[];
      for (const allocation of allocations) balances.set(allocation.party_id, (balances.get(allocation.party_id) ?? 0) + allocation.amount_cop);
    }
    const settlements = this.database.prepare("SELECT from_party_id,to_party_id,amount_cop FROM couple_settlements ORDER BY recorded_at,id").all() as unknown as SettlementRow[];
    let settlementsCop = 0;
    for (const settlement of settlements) {
      settlementsCop += settlement.amount_cop;
      balances.set(settlement.from_party_id, (balances.get(settlement.from_party_id) ?? 0) - settlement.amount_cop);
      balances.set(settlement.to_party_id, (balances.get(settlement.to_party_id) ?? 0) + settlement.amount_cop);
    }
    const audit = this.database.prepare("SELECT COUNT(*) AS count FROM couple_audit_events").get() as unknown as CountRow;
    return {
      parties: this.listParties(),
      spendingCop,
      incomeCop: 0,
      settlementsCop,
      expenseCount: expenses.length,
      settlementCount: settlements.length,
      auditEventCount: audit.count,
      balances: [...balances].map(([partyId, balanceCop]) => ({ partyId, balanceCop })),
    };
  }

  private seedParties(): void {
    const insert = this.database.prepare(`INSERT OR IGNORE INTO couple_parties
      (id,display_name,role,consent_status,bank_statement_consent,source_system,source_hash,imported_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    const importedAt = "2026-09-06T00:00:00.000Z";
    const parties: CoupleParty[] = [
      { id: "alex", displayName: "Alex", role: "owner", consentStatus: "active", bankStatementConsent: "active" },
      { id: "sam", displayName: "Sam", role: "partner", consentStatus: "pending", bankStatementConsent: "pending" },
    ];
    for (const party of parties) insert.run(party.id, party.displayName, party.role, party.consentStatus, party.bankStatementConsent, "jarvis-v1-seed", hash(party), importedAt);
  }

  private getParty(partyId: CouplePartyId): CoupleParty {
    if (partyId !== "alex" && partyId !== "sam") throw new Error("Unknown couple party.");
    const row = this.database.prepare("SELECT id,display_name,role,consent_status,bank_statement_consent FROM couple_parties WHERE id=?")
      .get(partyId) as unknown as PartyRow | undefined;
    if (!row) throw new Error("Unknown couple party.");
    return { id: row.id, displayName: row.display_name, role: row.role, consentStatus: row.consent_status, bankStatementConsent: row.bank_statement_consent };
  }

  private recordAudit(eventType: "shared_expense_recorded" | "settlement_recorded", entityId: string, payloadHash: string, sourceSystem: string, idempotencyKey: string, recordedAt: string): void {
    this.database.prepare(`INSERT INTO couple_audit_events
      (id,event_type,entity_id,payload_hash,source_system,idempotency_key,recorded_at) VALUES (?,?,?,?,?,?,?)`)
      .run(randomUUID(), eventType, entityId, payloadHash, sourceSystem, idempotencyKey, recordedAt);
  }
}

function normalizeExpense(input: SharedExpenseInput): SharedExpenseInput {
  const amountCop = positiveCop(input.amountCop, "amountCop");
  const allocations = input.allocations.map((allocation) => ({
    partyId: partyId(allocation.partyId),
    amountCop: positiveCop(allocation.amountCop, "allocation amountCop"),
  })).sort((left, right) => left.partyId.localeCompare(right.partyId));
  if (allocations.length < 1 || allocations.length > 2 || new Set(allocations.map(({ partyId: id }) => id)).size !== allocations.length) {
    throw new Error("Expense allocations must contain one unique allocation per party.");
  }
  if (allocations.reduce((sum, allocation) => sum + allocation.amountCop, 0) !== amountCop) {
    throw new Error("Expense allocations must sum exactly to amountCop.");
  }
  return {
    description: text(input.description, "description", 300),
    amountCop,
    incurredOn: canonicalDate(input.incurredOn, "incurredOn"),
    paidByPartyId: partyId(input.paidByPartyId),
    allocations,
    sourceSystem: text(input.sourceSystem, "sourceSystem", 120),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 200),
  };
}

function normalizeSettlement(input: SettlementInput): Required<SettlementInput> {
  const fromPartyId = partyId(input.fromPartyId);
  const toPartyId = partyId(input.toPartyId);
  if (fromPartyId === toPartyId) throw new Error("Settlement parties must differ.");
  return {
    fromPartyId,
    toPartyId,
    amountCop: positiveCop(input.amountCop, "amountCop"),
    occurredOn: canonicalDate(input.occurredOn, "occurredOn"),
    note: input.note === undefined ? "" : text(input.note, "note", 500),
    sourceSystem: text(input.sourceSystem, "sourceSystem", 120),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 200),
  };
}

function partyId(value: string): CouplePartyId {
  if (value !== "alex" && value !== "sam") throw new Error("Unknown couple party.");
  return value;
}

function positiveCop(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer COP amount.`);
  return value;
}

function text(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  return normalized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
