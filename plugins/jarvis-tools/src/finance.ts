import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const FINANCE_CATEGORIES = [
  "income",
  "rent",
  "motorcycle_installment",
  "fuel",
  "motorcycle_maintenance",
  "food_university",
  "food_out",
  "groceries",
  "cleaning",
  "personal",
  "subscriptions",
  "savings",
  "internal_transfer",
  "transfer_candidate",
  "unidentified",
] as const;

export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];
export type FinanceProvider = "nequi" | "banco_occidente";

export interface FinancialTransaction {
  id: string;
  provider: FinanceProvider;
  accountId: string;
  date: string;
  description: string;
  amountCents: number;
  category: FinanceCategory;
}

export interface ParseResult {
  transactions: FinancialTransaction[];
  unparsedLines: string[];
}

export interface PdfTextExtractor {
  extract(filePath: string): Promise<string>;
}

export class PdfJsTextExtractor implements PdfTextExtractor {
  async extract(filePath: string): Promise<string> {
    const data = new Uint8Array(await readFile(filePath));
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) => {
        if (!("str" in item)) return [];
        return [{
          str: item.str,
          transform: Array.from(item.transform),
          hasEOL: item.hasEOL,
        }];
      });
      pages.push(reconstructPdfRows(items).join("\n"));
    }
    return pages.join("\n");
  }
}

export interface PdfPositionedTextItem {
  str: string;
  transform: number[];
  hasEOL: boolean;
}

export function reconstructPdfRows(items: PdfPositionedTextItem[]): string[] {
  const rows: string[] = [];
  let current = "";
  let currentY: number | undefined;
  const flush = (): void => {
    const normalized = current.replace(/\s+/g, " ").trim();
    if (normalized) rows.push(normalized);
    current = "";
    currentY = undefined;
  };
  for (const item of items) {
    const y = item.transform[5];
    if (current && y !== undefined && currentY !== undefined && Math.abs(y - currentY) > 2) flush();
    current += item.str;
    if (y !== undefined) currentY = y;
    if (item.hasEOL) flush();
  }
  flush();
  return rows;
}

export interface SafeAmbiguitySummary {
  id: string;
  category: "unidentified" | "transfer_candidate";
  reason: "unparsed_statement_row" | "unidentified_transaction" | "manual_transfer_confirmation_required";
}

export function redactAmbiguities(lines: string[]): SafeAmbiguitySummary[] {
  return lines.map((line, index) => ({
    id: createHash("sha256").update(`${index}|${line}`).digest("hex").slice(0, 16),
    category: "unidentified",
    reason: "unparsed_statement_row",
  }));
}

export class FileBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileBoundaryError";
  }
}

export async function resolveImportPdf(importDirectory: string, requestedName: string): Promise<string> {
  return resolveImportFile(importDirectory, requestedName, ".pdf");
}

export async function resolveImportIcs(importDirectory: string, requestedName: string): Promise<string> {
  return resolveImportFile(importDirectory, requestedName, ".ics");
}

async function resolveImportFile(importDirectory: string, requestedName: string, extension: ".pdf" | ".ics"): Promise<string> {
  if (!requestedName || path.isAbsolute(requestedName) || path.extname(requestedName).toLowerCase() !== extension) {
    throw new FileBoundaryError(`Only relative ${extension} filenames inside the configured import directory are accepted.`);
  }
  const root = await realpath(importDirectory);
  const candidate = path.resolve(root, requestedName);
  if (!isInside(root, candidate)) throw new FileBoundaryError("Path traversal outside the import directory is forbidden.");
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink()) throw new FileBoundaryError("Symbolic links are forbidden for financial imports.");
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved) || !stat.isFile()) {
    throw new FileBoundaryError("The requested statement must be a regular file inside the import directory.");
  }
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

const NEQUI_LINE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$/;
const OCCIDENTE_LINE = /^(\d{2}-\d{2}-\d{4})\s+(.+?)\s+(-?[\d,]+\.\d{2})$/;

export function parseNequi(text: string, accountId: string): ParseResult {
  return parseLines(text, "nequi", accountId, NEQUI_LINE, (date) => normalizeDate(date, "/"), parseCopComma);
}

export function parseBancoOccidente(text: string, accountId: string): ParseResult {
  return parseLines(text, "banco_occidente", accountId, OCCIDENTE_LINE, (date) => normalizeDate(date, "-"), parseDotDecimal);
}

function parseLines(
  text: string,
  provider: FinanceProvider,
  accountId: string,
  pattern: RegExp,
  parseDate: (value: string) => string,
  parseAmount: (value: string) => number,
): ParseResult {
  const transactions: FinancialTransaction[] = [];
  const unparsedLines: string[] = [];
  const occurrences = new Map<string, number>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const match = pattern.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) {
      unparsedLines.push(line);
      continue;
    }
    const date = parseDate(match[1]);
    const description = match[2].trim();
    const amountCents = parseAmount(match[3]);
    const fingerprint = `${provider}|${accountId}|${date}|${description}|${amountCents}`;
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    transactions.push({
      id: createTransactionId(fingerprint, occurrence),
      provider,
      accountId,
      date,
      description,
      amountCents,
      category: categorize(description, amountCents),
    });
  }
  return { transactions, unparsedLines };
}

function normalizeDate(value: string, separator: "/" | "-"): string {
  const [day, month, year] = value.split(separator);
  if (!day || !month || !year) throw new Error("Invalid statement date.");
  return `${year}-${month}-${day}`;
}

function parseCopComma(value: string): number {
  const normalized = value.replaceAll(".", "").replace(",", ".");
  return Math.round(Number(normalized) * 100);
}

function parseDotDecimal(value: string): number {
  return Math.round(Number(value.replaceAll(",", "")) * 100);
}

function createTransactionId(fingerprint: string, occurrence: number): string {
  return createHash("sha256").update(`${fingerprint}|occurrence:${occurrence}`).digest("hex").slice(0, 24);
}

export function categorize(description: string, amountCents: number): FinanceCategory {
  const normalized = description.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/transferencia|traslado/.test(normalized)) return "transfer_candidate";
  if (amountCents > 0) return "income";
  if (/arriendo|alquiler/.test(normalized)) return "rent";
  if (/cuota.*moto|credito.*moto/.test(normalized)) return "motorcycle_installment";
  if (/gasolina|combustible/.test(normalized)) return "fuel";
  if (/taller|mantenimiento.*moto/.test(normalized)) return "motorcycle_maintenance";
  if (/universidad|cafeteria u|almuerzo u/.test(normalized)) return "food_university";
  if (/restaurante|almuerzo|comida|domicilio/.test(normalized)) return "food_out";
  if (/mercado|exito|d1|ara|olimpica/.test(normalized)) return "groceries";
  if (/aseo|limpieza/.test(normalized)) return "cleaning";
  if (/maquillaje|personal/.test(normalized)) return "personal";
  if (/netflix|spotify|suscripcion/.test(normalized)) return "subscriptions";
  if (/ahorro/.test(normalized)) return "savings";
  return "unidentified";
}

export interface InternalTransferPair {
  debitId: string;
  creditId: string;
  amountCents: number;
}

export interface ReconciliationResult {
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  internalTransfers: InternalTransferPair[];
  ambiguous: SafeAmbiguitySummary[];
  manualConfirmationRequired: SafeAmbiguitySummary[];
  transactionCount: number;
}

export function reconcileTransactions(all: FinancialTransaction[], month: string): ReconciliationResult {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must use YYYY-MM format.");
  const transactions = all.filter((transaction) => transaction.date.startsWith(`${month}-`));
  const pairedIds = new Set<string>();
  const internalTransfers: InternalTransferPair[] = [];
  const transferCandidates = transactions.filter((transaction) => transaction.category === "transfer_candidate");
  for (const debit of transferCandidates.filter((transaction) => transaction.amountCents < 0)) {
    const debitTime = Date.parse(`${debit.date}T00:00:00Z`);
    const debitReference = ownAccountTransferReference(debit.description);
    if (!debitReference) continue;
    const credit = transferCandidates.find((candidate) =>
      candidate.amountCents === -debit.amountCents &&
      candidate.accountId !== debit.accountId &&
      !pairedIds.has(candidate.id) &&
      ownAccountTransferReference(candidate.description) === debitReference &&
      Math.abs(Date.parse(`${candidate.date}T00:00:00Z`) - debitTime) <= 2 * 86_400_000,
    );
    if (credit) {
      pairedIds.add(debit.id);
      pairedIds.add(credit.id);
      internalTransfers.push({ debitId: debit.id, creditId: credit.id, amountCents: credit.amountCents });
    }
  }
  const external = transactions.filter((transaction) => !pairedIds.has(transaction.id));
  const incomeCents = external.filter((transaction) => transaction.amountCents > 0).reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const expenseCents = -external.filter((transaction) => transaction.amountCents < 0).reduce((sum, transaction) => sum + transaction.amountCents, 0);
  return {
    month,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    internalTransfers,
    ambiguous: external
      .filter((transaction) => transaction.category === "unidentified")
      .map((transaction) => ({ id: transaction.id, category: "unidentified", reason: "unidentified_transaction" })),
    manualConfirmationRequired: external
      .filter((transaction) => transaction.category === "transfer_candidate")
      .map((transaction) => ({ id: transaction.id, category: "transfer_candidate", reason: "manual_transfer_confirmation_required" })),
    transactionCount: transactions.length,
  };
}

function ownAccountTransferReference(description: string): string | undefined {
  const normalized = description.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
  if (!/CUENTAS? PROPIAS?/.test(normalized)) return undefined;
  return /\bREF(?:ERENCIA)?[: #-]*([A-Z0-9]{4,32})\b/.exec(normalized)?.[1];
}

interface FinancialTransactionRow {
  id: string;
  provider: FinanceProvider;
  account_id: string;
  date: string;
  description: string;
  amount_cents: number;
  category: FinanceCategory;
}

export class FinanceStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS financial_transactions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        category TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS financial_transactions_date_idx ON financial_transactions(date);
    `);
  }

  save(transactions: FinancialTransaction[]): number {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO financial_transactions
        (id, provider, account_id, date, description, amount_cents, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const transaction of transactions) {
        const result = statement.run(
          transaction.id,
          transaction.provider,
          transaction.accountId,
          transaction.date,
          transaction.description,
          transaction.amountCents,
          transaction.category,
        );
        inserted += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  reconcile(month: string): ReconciliationResult {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must use YYYY-MM format.");
    const rows = this.db.prepare(
      "SELECT * FROM financial_transactions WHERE date >= ? AND date < ? ORDER BY date, id",
    ).all(`${month}-01`, nextMonth(month)) as unknown as FinancialTransactionRow[];
    return reconcileTransactions(rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountId: row.account_id,
      date: row.date,
      description: row.description,
      amountCents: row.amount_cents,
      category: row.category,
    })), month);
  }

  close(): void {
    this.db.close();
  }
}

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (monthNumber === 12) return `${year + 1}-01-01`;
  return `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}
