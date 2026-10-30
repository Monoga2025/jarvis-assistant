export interface AcademicImportPolicy {
  category: string;
  timeZone: "America/Bogota";
  termStart: string;
  termEnd: string;
}

export interface AcademicEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  category: string;
  protected: true;
}

export interface RejectedAcademicEvent {
  uid: string;
  reason: "outside_academic_term" | "duplicate_uid";
}

export interface AcademicImportResult {
  accepted: AcademicEvent[];
  rejected: RejectedAcademicEvent[];
  ignoredCategoryCount: number;
}

export function importAcademicIcs(source: string, policy: AcademicImportPolicy): AcademicImportResult {
  assertDate(policy.termStart, "termStart");
  assertDate(policy.termEnd, "termEnd");
  if (policy.termEnd < policy.termStart) throw new Error("Academic term end must not precede its start.");
  const lines = unfoldLines(source);
  const rawEvents = collectEvents(lines);
  const accepted: AcademicEvent[] = [];
  const rejected: RejectedAcademicEvent[] = [];
  const seen = new Set<string>();
  let ignoredCategoryCount = 0;

  for (const raw of rawEvents) {
    const categories = (raw.get("CATEGORIES")?.value ?? "").split(",").map((value) => unescapeIcs(value).trim());
    if (!categories.includes(policy.category)) {
      ignoredCategoryCount += 1;
      continue;
    }
    const uid = requireProperty(raw, "UID").value;
    if (seen.has(uid)) {
      rejected.push({ uid, reason: "duplicate_uid" });
      continue;
    }
    seen.add(uid);
    const startProperty = requireProperty(raw, "DTSTART");
    const endProperty = requireProperty(raw, "DTEND");
    const start = parseBogotaDateTime(startProperty, policy.timeZone);
    const end = parseBogotaDateTime(endProperty, policy.timeZone);
    if (Date.parse(end) <= Date.parse(start)) throw new Error(`Event ${uid} has an invalid time range.`);
    const localStartDate = start.slice(0, 10);
    const localEndDate = end.slice(0, 10);
    if (localStartDate < policy.termStart || localEndDate > policy.termEnd) {
      rejected.push({ uid, reason: "outside_academic_term" });
      continue;
    }
    accepted.push({
      uid,
      summary: unescapeIcs(requireProperty(raw, "SUMMARY").value),
      start,
      end,
      category: policy.category,
      protected: true,
    });
  }

  accepted.sort((a, b) => a.start.localeCompare(b.start));
  return { accepted, rejected, ignoredCategoryCount };
}

interface IcsProperty { parameters: Record<string, string>; value: string }
type RawEvent = Map<string, IcsProperty>;

function unfoldLines(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line.replace(/\r$/, ""));
    }
  }
  return unfolded;
}

function collectEvents(lines: string[]): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | undefined;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      if (current) throw new Error("Nested VEVENT is invalid.");
      current = new Map();
      continue;
    }
    if (line === "END:VEVENT") {
      if (!current) throw new Error("Unexpected VEVENT terminator.");
      events.push(current);
      current = undefined;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const head = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [name, ...parameterParts] = head.split(";");
    if (!name) continue;
    const parameters: Record<string, string> = {};
    for (const part of parameterParts) {
      const equal = part.indexOf("=");
      if (equal > 0) parameters[part.slice(0, equal).toUpperCase()] = part.slice(equal + 1);
    }
    current.set(name.toUpperCase(), { parameters, value });
  }
  if (current) throw new Error("Unterminated VEVENT.");
  return events;
}

function requireProperty(event: RawEvent, name: string): IcsProperty {
  const property = event.get(name);
  if (!property?.value) throw new Error(`Academic event is missing ${name}.`);
  return property;
}

function parseBogotaDateTime(property: IcsProperty, expectedTimeZone: string): string {
  if (property.parameters.TZID !== expectedTimeZone) {
    throw new Error(`Academic event timezone must be ${expectedTimeZone}.`);
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(property.value);
  if (!match) throw new Error("Academic event date-time must be a local second-precision value.");
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}-05:00`;
}

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}