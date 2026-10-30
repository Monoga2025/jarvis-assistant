import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { CoupleStore } from "../plugins/jarvis-tools/src/couple.js";
import { FileBoundaryError } from "../plugins/jarvis-tools/src/finance.js";
import plugin from "../plugins/jarvis-tools/src/index.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-couple-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "jarvis.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CoupleStore", () => {
  it("seeds Alex as owner and keeps Sam bank access pending without a consent-grant API", async () => {
    const store = new CoupleStore(await databasePath());
    try {
      assert.deepEqual(store.listParties(), [
        { id: "alex", displayName: "Alex", role: "owner", consentStatus: "active", bankStatementConsent: "active" },
        { id: "sam", displayName: "Sam", role: "partner", consentStatus: "pending", bankStatementConsent: "pending" },
      ]);
      assert.doesNotThrow(() => store.assertBankStatementImportAllowed("alex"));
      assert.throws(() => store.assertBankStatementImportAllowed("sam"), /personally grant scoped consent/i);
      assert.equal("grantConsent" in store, false);
    } finally {
      store.close();
    }
  });

  it("blocks Sam statement imports at the plugin boundary before reading a file", async () => {
    const file = await databasePath();
    const registered: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> = [];
    plugin.register({
      pluginConfig: {
        primaryCalendarId: "primary",
        managedCalendarId: "managed",
        importDirectory: "C:/path-that-must-not-be-read",
        databasePath: file,
        googleClientIdFile: "C:/unused/client-id",
        googleClientSecretFile: "C:/unused/client-secret",
        googleRefreshTokenFile: "C:/unused/refresh-token",
      },
      registerTool(tool: { name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }) { registered.push(tool); },
      registerCommand() {},
      registerMemoryPromptPreparation() {},
      registerInteractiveHandler() {},
    } as never);
    const financeImport = registered.find(({ name }) => name === "finance_import_statement");
    assert.ok(financeImport);
    await assert.rejects(
      () => financeImport.execute("consent-boundary", {
        fileName: "statement.pdf",
        provider: "banco_occidente",
        accountId: "sam-occidente",
        partyId: "sam",
      }),
      /personally grant scoped consent/i,
    );

    await assert.rejects(
      () => financeImport.execute("account-owner-bypass", {
        fileName: "../must-not-be-resolved.pdf",
        provider: "banco_occidente",
        accountId: "sam-occidente",
        partyId: "alex",
      }),
      (error: unknown) => {
        assert.equal(error instanceof FileBoundaryError, false, "resolveImportPdf must not be reached");
        assert.match((error as Error).message, /belongs to Sam/i);
        return true;
      },
    );
  });

  it("rejects impossible calendar dates before storing shared expenses", async () => {
    const store = new CoupleStore(await databasePath());
    try {
      assert.throws(() => store.recordSharedExpense({
        description: "Impossible expense",
        amountCop: 10_000,
        incurredOn: "2026-02-30",
        paidByPartyId: "alex",
        allocations: [{ partyId: "alex", amountCop: 10_000 }],
        sourceSystem: "test",
        idempotencyKey: "impossible-date",
      }), /incurredOn must use YYYY-MM-DD/i);
      assert.equal(store.summary().expenseCount, 0);
    } finally {
      store.close();
    }
  });

  it("requires exact integer-COP allocations and excludes settlements from income and spending", async () => {
    const store = new CoupleStore(await databasePath(), () => new Date("2026-09-06T15:00:00Z"));
    try {
      assert.throws(() => store.recordSharedExpense({
        description: "Rent",
        amountCop: 700_000,
        incurredOn: "2026-09-01",
        paidByPartyId: "alex",
        allocations: [{ partyId: "alex", amountCop: 350_000 }, { partyId: "sam", amountCop: 349_999 }],
        sourceSystem: "test",
        idempotencyKey: "expense-invalid",
      }), /sum exactly/i);

      store.recordSharedExpense({
        description: "Groceries",
        amountCop: 100_000,
        incurredOn: "2026-09-05",
        paidByPartyId: "alex",
        allocations: [{ partyId: "alex", amountCop: 60_000 }, { partyId: "sam", amountCop: 40_000 }],
        sourceSystem: "test",
        idempotencyKey: "expense-1",
      });
      store.recordSettlement({
        fromPartyId: "sam",
        toPartyId: "alex",
        amountCop: 15_000,
        occurredOn: "2026-09-06",
        note: "Partial reimbursement",
        sourceSystem: "test",
        idempotencyKey: "settlement-1",
      });

      const summary = store.summary();
      assert.equal(summary.spendingCop, 100_000);
      assert.equal(summary.incomeCop, 0);
      assert.equal(summary.settlementsCop, 15_000);
      assert.deepEqual(summary.balances, [
        { partyId: "alex", balanceCop: -25_000 },
        { partyId: "sam", balanceCop: 25_000 },
      ]);
    } finally {
      store.close();
    }
  });

  it("is restart-idempotent, rejects changed payloads, and keeps provenance audit append-only", async () => {
    const file = await databasePath();
    const expense = {
      description: "Motorcycle installment",
      amountCop: 410_000,
      incurredOn: "2026-09-05",
      paidByPartyId: "alex" as const,
      allocations: [{ partyId: "alex" as const, amountCop: 410_000 }],
      sourceSystem: "telegram",
      idempotencyKey: "expense-restart",
    };
    const settlement = {
      fromPartyId: "sam" as const,
      toPartyId: "alex" as const,
      amountCop: 20_000,
      occurredOn: "2026-09-06",
      sourceSystem: "telegram",
      idempotencyKey: "settlement-restart",
    };

    const first = new CoupleStore(file, () => new Date("2026-09-06T15:00:00Z"));
    first.recordSharedExpense(expense);
    first.recordSettlement(settlement);
    first.close();

    const restarted = new CoupleStore(file, () => new Date("2026-09-07T15:00:00Z"));
    try {
      restarted.recordSharedExpense(expense);
      restarted.recordSettlement(settlement);
      assert.equal(restarted.summary().expenseCount, 1);
      assert.equal(restarted.summary().settlementCount, 1);
      assert.equal(restarted.summary().auditEventCount, 2);
      assert.throws(() => restarted.recordSharedExpense({ ...expense, amountCop: 420_000, allocations: [{ partyId: "alex", amountCop: 420_000 }] }), /idempotency key/i);
      assert.throws(() => restarted.recordSettlement({ ...settlement, amountCop: 25_000 }), /idempotency key/i);
    } finally {
      restarted.close();
    }

    const raw = new DatabaseSync(file);
    try {
      assert.throws(() => raw.exec("UPDATE couple_audit_events SET event_type='tampered'"), /append-only/i);
      assert.throws(() => raw.exec("DELETE FROM couple_audit_events"), /append-only/i);
    } finally {
      raw.close();
    }
  });
});
