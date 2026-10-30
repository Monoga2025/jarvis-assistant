import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeDay, planDay, planWeek, type ScheduleBlock } from "../plugins/jarvis-tools/src/routine.js";

const fixed: ScheduleBlock[] = [{
  id: "class-circuits",
  kind: "class",
  title: "Electrical Circuits",
  start: "2026-09-08T06:00:00-05:00",
  end: "2026-09-08T09:00:00-05:00",
  protected: true,
}];

describe("routine planning", () => {
  it("never moves protected blocks and shifts a conflicting flexible block", () => {
    const result = planDay({
      date: "2026-09-08",
      fixedBlocks: fixed,
      flexibleBlocks: [{
        id: "gym-tue",
        kind: "gym",
        title: "Gym",
        start: "2026-09-08T08:30:00-05:00",
        end: "2026-09-08T09:30:00-05:00",
        protected: false,
      }],
    });
    assert.deepEqual(result.blocks.find((block) => block.id === "class-circuits"), fixed[0]);
    assert.equal(result.blocks.find((block) => block.id === "gym-tue")?.start, "2026-09-08T09:15:00-05:00");
  });

  it("does not requeue missed protected commitments during close", () => {
    const result = closeDay({ blocks: fixed, completedBlockIds: [], blocker: "Traffic" });
    assert.deepEqual(result.requeueBlockIds, []);
    assert.equal(result.protectedMisses.length, 1);
  });

  it("derives protection from kind even when the caller lies", () => {
    const result = planDay({
      date: "2026-09-08",
      fixedBlocks: [],
      flexibleBlocks: [{
        id: "exam-1",
        kind: "exam",
        title: "Exam",
        start: "2026-09-08T08:00:00-05:00",
        end: "2026-09-08T10:00:00-05:00",
        protected: false,
      }],
    });
    assert.equal(result.blocks[0]?.protected, true);
    assert.deepEqual(result.movedBlockIds, []);
    const closed = closeDay({ blocks: result.blocks, completedBlockIds: [] });
    assert.deepEqual(closed.requeueBlockIds, []);
    assert.deepEqual(closed.protectedMisses, ["exam-1"]);
  });

  it("raises study to 18 hours in exam mode and reduces sales", () => {
    const normal = planWeek(false);
    const exam = planWeek(true);
    assert.equal(normal.studyHours, 14);
    assert.equal(normal.salesHours, 8);
    assert.equal(exam.studyHours, 18);
    assert.equal(exam.salesHours, 4);
    assert.equal(exam.sleepHours, 56);
  });

  it("automatically schedules 30-minute commute and lunch around class blocks", async () => {
    const { guideDay } = await import("../plugins/jarvis-tools/src/routine.js");
    const result = guideDay({
      date: "2026-09-08",
      fixedBlocks: [{
        id: "class-edo",
        kind: "class",
        title: "Ecuaciones Diferenciales",
        start: "2026-09-08T09:00:00-05:00",
        end: "2026-09-08T11:00:00-05:00",
        protected: true,
      }],
    });
    assert.ok(result);
    assert.equal(result.commuteCount, 2);
    assert.ok(result.schedule.some((b) => b.title.includes("Traslado") && b.start === "2026-09-08T08:30:00-05:00"));
    assert.ok(result.schedule.some((b) => b.title.includes("Regreso") && b.start === "2026-09-08T11:00:00-05:00"));
    assert.ok(result.schedule.some((b) => b.kind === "meal" && b.title.includes("Almuerzo")));
  });

  it("allocates 45-minute focus study blocks into free windows avoiding classes and commute", async () => {
    const { guideDay } = await import("../plugins/jarvis-tools/src/routine.js");
    const result = guideDay({
      date: "2026-09-08",
      fixedBlocks: [{
        id: "class-solids",
        kind: "class",
        title: "Mecánica de Sólidos",
        start: "2026-09-08T14:00:00-05:00",
        end: "2026-09-08T17:00:00-05:00",
        protected: true,
      }],
      tasks: [{ id: 1, title: "Taller EDO", subject: "EDO", dueAt: "2026-09-08T23:59:00-05:00" }],
    });
    assert.ok(result.focusBlocks.length >= 1);
    assert.equal(result.focusBlocks[0]?.durationMinutes, 45);
    assert.match(result.focusBlocks[0]?.title ?? "", /Taller EDO/);
    assert.match(result.summaryMessage, /Mecánica de Sólidos/);
    assert.match(result.recommendation, /foco/i);
  });
});
