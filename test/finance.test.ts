import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FileBoundaryError,
  FinanceStore,
  redactAmbiguities,
  reconstructPdfRows,
  parseBancoOccidente,
  parseNequi,
  reconcileTransactions,
  resolveImportPdf,
} from "../plugins/jarvis-tools/src/finance.js";

const nequiFixture = `
01/08/2026 PAGO ARRIENDO -700.000,00
02/08/2026 TRANSFERENCIA ENTRE CUENTAS PROPIAS REF ABC123 -200.000,00
03/08/2026 ALMUERZO UNIVERSIDAD -19.000,00
04/08/2026 PAGO RECIBIDO CLIENTE 1.800.000,00
LINEA DESCONOCIDA IMPORTANTE
`;

const occidenteFixture = `
02-08-2026 TRANSFERENCIA ENTRE CUENTAS PROPIAS REF ABC123 200000.00
05-08-2026 MERCADO EXITO -125000.00
`;

describe("financial statement parsing", () => {
  it("parses conservative Nequi patterns and reports unknown lines", () => {
    const result = parseNequi(nequiFixture, "nequi-personal");
    assert.equal(result.transactions.length, 4);
    assert.equal(result.transactions[0]?.amountCents, -70_000_000);
    assert.equal(result.transactions[2]?.category, "food_university");
    assert.deepEqual(result.unparsedLines, ["LINEA DESCONOCIDA IMPORTANTE"]);
  });

  it("reconstructs transaction rows from PDF positions and EOL markers", () => {
    assert.deepEqual(reconstructPdfRows([
      { str: "01/08/2026", transform: [1, 0, 0, 1, 10, 700], hasEOL: false },
      { str: " ALMUERZO", transform: [1, 0, 0, 1, 90, 700], hasEOL: false },
      { str: " -19.000,00", transform: [1, 0, 0, 1, 300, 700], hasEOL: true },
      { str: "02/08/2026", transform: [1, 0, 0, 1, 10, 680], hasEOL: false },
      { str: " TAXI -12.000,00", transform: [1, 0, 0, 1, 90, 680], hasEOL: true },
    ]), ["01/08/2026 ALMUERZO -19.000,00", "02/08/2026 TAXI -12.000,00"]);
  });

  it("redacts ambiguity content before returning it to an agent", () => {
    const raw = ["06/08/2026 COMPRA PRIVADA 123456789 -50.000,00"];
    const summary = redactAmbiguities(raw);
    assert.equal(summary.length, 1);
    assert.equal(JSON.stringify(summary).includes("COMPRA PRIVADA"), false);
    assert.equal(JSON.stringify(summary).includes("123456789"), false);
  });

  it("parses Banco de Occidente fixture without claiming real-statement coverage", () => {
    const result = parseBancoOccidente(occidenteFixture, "occidente-partner");
    assert.equal(result.transactions.length, 2);
    assert.equal(result.transactions[1]?.amountCents, -12_500_000);
  });
});

describe("financial reconciliation", () => {
  it("deduplicates matching internal transfers across accounts", () => {
    const transactions = [
      ...parseNequi(nequiFixture, "nequi-personal").transactions,
      ...parseBancoOccidente(occidenteFixture, "occidente-partner").transactions,
    ];
    const result = reconcileTransactions(transactions, "2026-08");
    assert.equal(result.internalTransfers.length, 1);
    assert.equal(result.incomeCents, 180_000_000);
    assert.equal(result.expenseCents, 84_400_000);
  });

  it("surfaces uncategorized transactions as ambiguous", () => {
    const parsed = parseNequi("06/08/2026 XYZ SERVICIO RARO -50.000,00", "nequi-personal");
    const result = reconcileTransactions(parsed.transactions, "2026-08");
    assert.equal(result.ambiguous.length, 1);
    assert.equal(result.ambiguous[0]?.category, "unidentified");
  });

  it("does not treat an unreferenced transfer as internal", () => {
    const nequi = parseNequi("07/08/2026 TRANSFERENCIA -200.000,00", "nequi-personal");
    const occidente = parseBancoOccidente("07-08-2026 TRANSFERENCIA 200000.00", "occidente-partner");
    const result = reconcileTransactions([...nequi.transactions, ...occidente.transactions], "2026-08");
    assert.equal(result.internalTransfers.length, 0);
    assert.equal(result.manualConfirmationRequired.length, 2);
  });

  it("keeps identical same-day purchases distinct while reimport stays idempotent", () => {
    const parsed = parseNequi("03/08/2026 ALMUERZO UNIVERSIDAD -19.000,00\n03/08/2026 ALMUERZO UNIVERSIDAD -19.000,00", "nequi-personal");
    assert.equal(new Set(parsed.transactions.map((item) => item.id)).size, 2);
    const store = new FinanceStore(":memory:");
    assert.equal(store.save(parsed.transactions), 2);
    assert.equal(store.save(parsed.transactions), 0);
    assert.equal(store.reconcile("2026-08").transactionCount, 2);
    store.close();
  });

  it("persists imports idempotently before reconciliation", () => {
    const store = new FinanceStore(":memory:");
    const parsed = parseNequi(nequiFixture, "nequi-personal");
    assert.equal(store.save(parsed.transactions), 4);
    assert.equal(store.save(parsed.transactions), 0);
    assert.equal(store.reconcile("2026-08").transactionCount, 4);
    store.close();
  });
});

describe("import directory boundary", () => {
  it("accepts an existing PDF inside the configured import directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-import-"));
    const file = path.join(root, "statement.pdf");
    await writeFile(file, "fixture");
    assert.equal(await resolveImportPdf(root, "statement.pdf"), file);
  });

  it("rejects traversal and symlinks escaping the import directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-import-"));
    const outside = await mkdtemp(path.join(tmpdir(), "jarvis-outside-"));
    const outsideFile = path.join(outside, "secret.pdf");
    await writeFile(outsideFile, "secret");
    await assert.rejects(resolveImportPdf(root, "../secret.pdf"), FileBoundaryError);
    if (process.platform === "win32") {
      await symlink(outside, path.join(root, "linked"), "junction");
    } else {
      await symlink(outsideFile, path.join(root, "linked.pdf"));
    }
    const linkName = process.platform === "win32" ? "linked/secret.pdf" : "linked.pdf";
    await assert.rejects(resolveImportPdf(root, linkName), FileBoundaryError);
  });
});
