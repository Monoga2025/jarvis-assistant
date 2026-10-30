export type BlockKind = "class" | "exam" | "commitment" | "study" | "sales" | "gym" | "meal" | "rest" | "church";

export interface ScheduleBlock {
  id: string;
  kind: BlockKind;
  title: string;
  start: string;
  end: string;
  protected: boolean;
}

export interface DayPlan {
  date: string;
  blocks: ScheduleBlock[];
  movedBlockIds: string[];
}

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const TRANSITION_BUFFER_MS = 15 * 60 * 1000;

export function planDay(input: {
  date: string;
  fixedBlocks: ScheduleBlock[];
  flexibleBlocks: ScheduleBlock[];
}): DayPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must use YYYY-MM-DD.");
  const fixedBlocks = input.fixedBlocks.map(enforceProtection);
  for (const block of fixedBlocks) {
    if (!block.protected) throw new Error("All fixed blocks must be protected.");
    assertBlockDate(block, input.date);
  }
  const blocks = [...fixedBlocks];
  const movedBlockIds: string[] = [];
  for (const unsafeRequested of input.flexibleBlocks) {
    const requested = enforceProtection(unsafeRequested);
    assertBlockDate(requested, input.date);
    if (requested.protected) {
      blocks.push(requested);
      continue;
    }
    const duration = Date.parse(requested.end) - Date.parse(requested.start);
    let startMs = Date.parse(requested.start);
    let endMs = startMs + duration;
    let moved = false;
    for (;;) {
      const conflict = blocks
        .filter((block) => overlaps(startMs, endMs, Date.parse(block.start), Date.parse(block.end)))
        .sort((a, b) => Date.parse(a.end) - Date.parse(b.end))[0];
      if (!conflict) break;
      startMs = Date.parse(conflict.end) + TRANSITION_BUFFER_MS;
      endMs = startMs + duration;
      moved = true;
    }
    const scheduled = moved
      ? { ...requested, start: formatBogota(startMs), end: formatBogota(endMs) }
      : requested;
    blocks.push(scheduled);
    if (moved) movedBlockIds.push(requested.id);
  }
  blocks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { date: input.date, blocks, movedBlockIds };
}

function assertBlockDate(block: ScheduleBlock, date: string): void {
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`Block ${block.id} has an invalid time range.`);
  }
  if (!block.start.startsWith(date) || !block.end.startsWith(date)) {
    throw new Error(`Block ${block.id} is outside the requested day.`);
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function formatBogota(utcMs: number): string {
  return `${new Date(utcMs - BOGOTA_OFFSET_MS).toISOString().slice(0, 19)}-05:00`;
}

export function closeDay(input: {
  blocks: ScheduleBlock[];
  completedBlockIds: string[];
  blocker?: string;
}): {
  completed: number;
  missed: number;
  blocker: string | null;
  requeueBlockIds: string[];
  protectedMisses: string[];
} {
  const completed = new Set(input.completedBlockIds);
  const blocks = input.blocks.map(enforceProtection);
  const missed = blocks.filter((block) => !completed.has(block.id));
  return {
    completed: blocks.length - missed.length,
    missed: missed.length,
    blocker: input.blocker?.trim() || null,
    requeueBlockIds: missed.filter((block) => !block.protected).map((block) => block.id),
    protectedMisses: missed.filter((block) => block.protected).map((block) => block.id),
  };
}

const PROTECTED_KINDS = new Set<BlockKind>(["class", "exam", "commitment"]);

function enforceProtection(block: ScheduleBlock): ScheduleBlock {
  return PROTECTED_KINDS.has(block.kind) && !block.protected ? { ...block, protected: true } : block;
}

export interface WeeklyTargets {
  sleepHours: number;
  classHours: number;
  studyHours: number;
  salesHours: number;
  gymSessions: number;
  mealPrepSessions: number;
  examMode: boolean;
}

export function planWeek(examMode: boolean): WeeklyTargets {
  return {
    sleepHours: 56,
    classHours: 32,
    studyHours: examMode ? 18 : 14,
    salesHours: examMode ? 4 : 8,
    gymSessions: 2,
    mealPrepSessions: 2,
    examMode,
  };
}

export interface GuideDayInput {
  date: string;
  fixedBlocks: ScheduleBlock[];
  tasks?: Array<{ id: number; title: string; subject: string; dueAt?: string | null; dueDate?: string | null }>;
  examMode?: boolean;
}

export interface DayGuidance {
  date: string;
  schedule: ScheduleBlock[];
  focusBlocks: Array<{ title: string; start: string; end: string; durationMinutes: number }>;
  commuteCount: number;
  studyHoursScheduled: number;
  summaryMessage: string;
  recommendation: string;
}

const COMMUTE_DURATION_MS = 30 * 60 * 1000;
const STUDY_BLOCK_MS = 45 * 60 * 1000;
const LUNCH_DURATION_MS = 45 * 60 * 1000;

export function guideDay(input: GuideDayInput): DayGuidance {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must use YYYY-MM-DD.");
  const fixed = input.fixedBlocks.map(enforceProtection);
  for (const block of fixed) {
    if (!block.protected) throw new Error("All fixed blocks must be protected.");
    assertBlockDate(block, input.date);
  }

  fixed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const schedule: ScheduleBlock[] = [...fixed];
  let commuteCount = 0;

  const classBlocks = fixed.filter((b) => b.kind === "class");
  for (let i = 0; i < classBlocks.length; i++) {
    const currentClass = classBlocks[i]!;
    const classStartMs = Date.parse(currentClass.start);
    const classEndMs = Date.parse(currentClass.end);

    const toStartMs = classStartMs - COMMUTE_DURATION_MS;
    const toEndMs = classStartMs;
    const conflictTo = schedule.some((b) => overlaps(toStartMs, toEndMs, Date.parse(b.start), Date.parse(b.end)));
    if (!conflictTo) {
      schedule.push({
        id: `commute-to-${currentClass.id}`,
        kind: "commitment",
        title: "🚗 Traslado a la universidad (30 min)",
        start: formatBogota(toStartMs),
        end: formatBogota(toEndMs),
        protected: true,
      });
      commuteCount += 1;
    }

    const nextClass = classBlocks[i + 1];
    const nextClassStartMs = nextClass ? Date.parse(nextClass.start) : Infinity;
    if (nextClassStartMs - classEndMs >= 60 * 60 * 1000) {
      const fromStartMs = classEndMs;
      const fromEndMs = classEndMs + COMMUTE_DURATION_MS;
      const conflictFrom = schedule.some((b) => overlaps(fromStartMs, fromEndMs, Date.parse(b.start), Date.parse(b.end)));
      if (!conflictFrom) {
        schedule.push({
          id: `commute-from-${currentClass.id}`,
          kind: "commitment",
          title: "🚗 Regreso a casa (30 min)",
          start: formatBogota(fromStartMs),
          end: formatBogota(fromEndMs),
          protected: true,
        });
        commuteCount += 1;
      }
    }
  }

  const lunchWindowStartMs = Date.parse(`${input.date}T12:00:00-05:00`);
  const lunchWindowEndMs = Date.parse(`${input.date}T14:00:00-05:00`);
  for (let candidateMs = lunchWindowStartMs; candidateMs + LUNCH_DURATION_MS <= lunchWindowEndMs; candidateMs += 15 * 60 * 1000) {
    const candidateEndMs = candidateMs + LUNCH_DURATION_MS;
    const conflict = schedule.some((b) => overlaps(candidateMs, candidateEndMs, Date.parse(b.start), Date.parse(b.end)));
    if (!conflict) {
      schedule.push({
        id: `meal-lunch-${input.date}`,
        kind: "meal",
        title: "🥪 Almuerzo (Kit cuarto / sandwichera)",
        start: formatBogota(candidateMs),
        end: formatBogota(candidateEndMs),
        protected: true,
      });
      break;
    }
  }

  const targetBlocks = input.examMode ? 4 : 3;
  const focusBlocks: Array<{ title: string; start: string; end: string; durationMinutes: number }> = [];
  const tasks = [...(input.tasks ?? [])];

  const dayStartMs = Date.parse(`${input.date}T08:00:00-05:00`);
  const dayEndMs = Date.parse(`${input.date}T22:00:00-05:00`);

  for (let candidateMs = dayStartMs; candidateMs + STUDY_BLOCK_MS <= dayEndMs && focusBlocks.length < targetBlocks; candidateMs += 15 * 60 * 1000) {
    const candidateEndMs = candidateMs + STUDY_BLOCK_MS;
    const conflict = schedule.some((b) => overlaps(candidateMs, candidateEndMs, Date.parse(b.start), Date.parse(b.end)));
    if (!conflict) {
      const task = tasks.shift();
      const taskTitle = task ? `🎯 Foco: ${task.title}` : `🎯 Bloque de estudio ${focusBlocks.length + 1} (45m)`;
      const block: ScheduleBlock = {
        id: `study-focus-${input.date}-${focusBlocks.length + 1}`,
        kind: "study",
        title: taskTitle,
        start: formatBogota(candidateMs),
        end: formatBogota(candidateEndMs),
        protected: false,
      };
      schedule.push(block);
      focusBlocks.push({
        title: taskTitle,
        start: block.start,
        end: block.end,
        durationMinutes: 45,
      });
      candidateMs = candidateEndMs + 15 * 60 * 1000 - 15 * 60 * 1000;
    }
  }

  schedule.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const classCount = classBlocks.length;
  const studyHoursScheduled = focusBlocks.length * 0.75;
  const summaryMessage = classCount > 0
    ? `Día con ${classCount} bloque(s) de clase (${classBlocks.map((c) => c.title).join(", ")}) y ${focusBlocks.length} sesión(es) de estudio de 45 min.`
    : `Día sin clases. ${focusBlocks.length} sesión(es) de estudio de 45 min programadas.`;

  const recommendation = focusBlocks.length > 0
    ? `Ejecuta tu primer bloque de foco a las ${focusBlocks[0]?.start.slice(11, 16)} y recuerda el descanso activo de 10 min sin celular.`
    : `Día despejado. Cumple con tus compromisos y mantén la consistencia.`;

  return {
    date: input.date,
    schedule,
    focusBlocks,
    commuteCount,
    studyHoursScheduled,
    summaryMessage,
    recommendation,
  };
}
