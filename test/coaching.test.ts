import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { CoachingStore } from "../plugins/jarvis-tools/src/coaching.js";
import plugin from "../plugins/jarvis-tools/src/index.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-coaching-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "jarvis.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CoachingStore", () => {
  it("rejects non-ISO and impossible instants before persistence", async () => {
    const store = new CoachingStore(await databasePath());
    try {
      const base = {
        kind: "study" as const,
        evidence: "Completed a focused study block",
        sourceSystem: "test",
        idempotencyKey: "invalid-instant",
      };
      assert.throws(() => store.recordCheckIn({ ...base, occurredAt: "0" }), /occurredAt must be an ISO timestamp/i);
      assert.throws(() => store.recordCheckIn({ ...base, occurredAt: "2026-02-30T10:00:00-05:00" }), /occurredAt must be an ISO timestamp/i);
      assert.equal(store.summary().consistency.study.currentWeek, 0);
    } finally {
      store.close();
    }
  });

  it("canonicalizes equivalent timestamp offsets before idempotency hashing", async () => {
    const file = await databasePath();
    const store = new CoachingStore(file);
    try {
      const first = store.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-05T15:00:00-05:00",
        evidence: "Completed the planned Circuitos exercises",
        sourceSystem: "telegram",
        idempotencyKey: "same-instant",
      });
      const replay = store.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-05T20:00:00Z",
        evidence: "Completed the planned Circuitos exercises",
        sourceSystem: "telegram",
        idempotencyKey: "same-instant",
      });
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
    } finally {
      store.close();
    }

    const raw = new DatabaseSync(file);
    try {
      const row = raw.prepare("SELECT occurred_at FROM coaching_checkins WHERE idempotency_key='same-instant'").get() as { occurred_at: string };
      assert.equal(row.occurred_at, "2026-09-05T20:00:00.000Z");
    } finally {
      raw.close();
    }
  });

  it("persists evidence-backed check-ins idempotently and summarizes current-week streaks", async () => {
    const file = await databasePath();
    const first = new CoachingStore(file, () => new Date("2026-09-06T20:00:00Z"));
    first.recordCheckIn({
      kind: "study",
      occurredAt: "2026-09-05T15:00:00-05:00",
      evidence: "Completed the planned Circuitos exercises",
      sourceSystem: "telegram",
      idempotencyKey: "study-2026-09-05",
    });
    first.close();

    const restarted = new CoachingStore(file, () => new Date("2026-09-06T20:00:00Z"));
    try {
      restarted.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-05T15:00:00-05:00",
        evidence: "Completed the planned Circuitos exercises",
        sourceSystem: "telegram",
        idempotencyKey: "study-2026-09-05",
      });
      restarted.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-06T14:00:00-05:00",
        evidence: "Completed a second focused study block",
        sourceSystem: "telegram",
        idempotencyKey: "study-2026-09-06",
      });
      const summary = restarted.summary("2026-09-06T21:00:00Z");
      assert.deepEqual(summary.consistency.study, { currentWeek: 2, currentStreakDays: 2 });
      assert.deepEqual(summary.consistency.gym, { currentWeek: 0, currentStreakDays: 0 });
      assert.throws(() => restarted.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-05T15:00:00-05:00",
        evidence: "Different evidence",
        sourceSystem: "telegram",
        idempotencyKey: "study-2026-09-05",
      }), /idempotency key/i);
    } finally {
      restarted.close();
    }
  });

  it("suggests at most 45 gaming minutes only after verified productive work and a clean daily close", async () => {
    const store = new CoachingStore(await databasePath(), () => new Date("2026-09-06T23:00:00Z"));
    try {
      assert.equal(store.summary().reward.eligible, false);
      store.recordDayClose({
        localDate: "2026-09-06",
        criticalCommitmentsComplete: true,
        dailyCloseComplete: true,
        sourceSystem: "routine-close",
        idempotencyKey: "close-1",
      });
      assert.equal(store.summary().reward.eligible, false);
      store.recordCheckIn({
        kind: "deep_work",
        occurredAt: "2026-09-06T17:00:00-05:00",
        evidence: "One uninterrupted 50-minute block with the phone away",
        sourceSystem: "telegram",
        idempotencyKey: "deep-work-1",
      });
      const reward = store.summary().reward;
      assert.equal(reward.eligible, true);
      assert.equal(reward.gamingMinutes, 45);
      assert.doesNotMatch(reward.suggestion ?? "", /spend|buy|punish|shame/i);

      store.recordDayClose({
        localDate: "2026-09-07",
        criticalCommitmentsComplete: false,
        dailyCloseComplete: true,
        sourceSystem: "routine-close",
        idempotencyKey: "close-2",
      });
      store.recordCheckIn({
        kind: "study",
        occurredAt: "2026-09-07T17:00:00-05:00",
        evidence: "Completed study block",
        sourceSystem: "telegram",
        idempotencyKey: "study-2",
      });
      assert.equal(store.summary("2026-09-08T02:00:00Z").reward.eligible, false);
    } finally {
      store.close();
    }
  });

  it("persists critical-commitment completion through the existing routine close tool", async () => {
    const file = await databasePath();
    const registered: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> = [];
    plugin.register({
      pluginConfig: {
        primaryCalendarId: "primary",
        managedCalendarId: "managed",
        importDirectory: "C:/unused",
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
    const close = registered.find(({ name }) => name === "routine_close_day");
    assert.ok(close);
    await close.execute("close-2026-09-06", {
      date: "2026-09-06",
      blocks: [{ id: "class-1", kind: "class", title: "Protected class", start: "2026-09-06T08:00:00-05:00", end: "2026-09-06T09:00:00-05:00", protected: true }],
      completedBlockIds: ["class-1"],
    });
    const store = new CoachingStore(file);
    try {
      store.recordCheckIn({ kind: "study", occurredAt: "2026-09-06T10:00:00-05:00", evidence: "Completed study block", sourceSystem: "test", idempotencyKey: "study-close-integration" });
      assert.equal(store.summary("2026-09-06T23:00:00-05:00").reward.eligible, true);
    } finally {
      store.close();
    }
  });

  it("deduplicates proactive coaching and enforces enabled state plus a fixed cooldown", async () => {
    let now = new Date("2026-09-06T15:00:00Z");
    const store = new CoachingStore(await databasePath(), () => now);
    try {
      assert.deepEqual(store.coachStatus(), { enabled: true, cooldownMinutes: 180, lastClaimedAt: null });
      assert.deepEqual(store.claimProactive("morning:2026-09-06"), { shouldSend: true, reason: "claimed" });
      assert.deepEqual(store.claimProactive("morning:2026-09-06"), { shouldSend: false, reason: "duplicate" });
      now = new Date("2026-09-06T16:00:00Z");
      assert.deepEqual(store.claimProactive("nudge:study"), { shouldSend: false, reason: "cooldown" });
      now = new Date("2026-09-06T18:01:00Z");
      assert.deepEqual(store.claimProactive("nudge:study"), { shouldSend: true, reason: "claimed" });
      store.setCoachEnabled(false);
      assert.equal(store.coachStatus().enabled, false);
      assert.deepEqual(store.claimProactive("night:2026-09-06"), { shouldSend: false, reason: "disabled" });
      store.setCoachEnabled(true);
      assert.equal(store.coachStatus().enabled, true);
    } finally {
      store.close();
    }
  });
});
