const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function canonicalDate(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} must use YYYY-MM-DD.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const instant = new Date(0);
  instant.setUTCHours(0, 0, 0, 0);
  instant.setUTCFullYear(year, month - 1, day);
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  return value;
}

export function canonicalInstant(value: string, field: string): string {
  const match = ISO_INSTANT.exec(value);
  if (!match) throw new Error(`${field} must be an ISO timestamp.`);
  const [, year, month, day, hourText, minuteText, secondText] = match;
  const offset = match[8]!;
  try {
    canonicalDate(`${year}-${month}-${day}`, field);
  } catch {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${field} must be an ISO timestamp.`);
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw new Error(`${field} must be an ISO timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO timestamp.`);
  return new Date(milliseconds).toISOString();
}
