import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SalesStore } from "../plugins/jarvis-tools/src/sales.js";

describe("SalesStore", () => {
  it("creates prospects and prevents duplicate normalized company names", () => {
    const store = new SalesStore(":memory:", () => new Date("2026-09-01T12:00:00Z"));
    const prospect = store.createProspect({
      companyName: "Industrias Ejemplo SAS",
      contactName: "Laura",
      contactChannel: "WhatsApp",
      source: "industrias-marel-network",
    });
    assert.equal(prospect.stage, "researched");
    assert.throws(() => store.createProspect({
      companyName: " industrias ejemplo sas ",
      contactName: "Otra",
      contactChannel: "WhatsApp",
      source: "industrias-marel-network",
    }));
    store.close();
  });

  it("prepares a draft without recording it as sent", () => {
    const store = new SalesStore(":memory:");
    const prospect = store.createProspect({
      companyName: "Tornillos Norte",
      contactName: "Camilo",
      contactChannel: "WhatsApp",
      source: "industrias-marel-network",
    });
    const draft = store.prepareOutreach(prospect.id);
    assert.match(draft.message, /15 minutos/);
    assert.match(draft.message, /Tornillos Norte/);
    assert.equal(store.getProspect(prospect.id).stage, "researched");
    store.close();
  });

  it("records outcomes and computes the rolling 30-day funnel", () => {
    const store = new SalesStore(":memory:", () => new Date("2026-09-01T12:00:00Z"));
    const p1 = store.createProspect({ companyName: "A", contactName: "Ana", contactChannel: "WhatsApp", source: "warm" });
    const p2 = store.createProspect({ companyName: "B", contactName: "Beto", contactChannel: "WhatsApp", source: "warm" });
    store.recordOutcome({ prospectId: p1.id, outcome: "contacted", occurredAt: "2026-09-01T15:00:00Z" });
    store.recordOutcome({ prospectId: p1.id, outcome: "conversation", occurredAt: "2026-09-02T15:00:00Z" });
    store.recordOutcome({ prospectId: p1.id, outcome: "diagnosis", occurredAt: "2026-09-03T15:00:00Z" });
    store.recordOutcome({ prospectId: p1.id, outcome: "won", occurredAt: "2026-09-04T15:00:00Z", contractedCents: 150_000_000 });
    store.recordOutcome({ prospectId: p2.id, outcome: "contacted", occurredAt: "2026-09-02T15:00:00Z" });
    const metrics = store.metrics30Days("2026-09-04T23:00:00Z");
    assert.deepEqual(metrics, {
      prospectsCreated: 2,
      contacted: 2,
      conversations: 1,
      diagnoses: 1,
      won: 1,
      contractedCents: 150_000_000,
    });
    store.close();
  });
});
