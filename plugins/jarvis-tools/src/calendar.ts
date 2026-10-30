import { createHash } from "node:crypto";

export interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees?: Array<{ email: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleCalendarClient {
  queryFreeBusy(calendarIds: string[], start: string, end: string): Promise<CalendarEvent[]>;
  listAgenda(calendarId: string, start: string, end: string, includeDescription?: boolean): Promise<CalendarEvent[]>;
  insertEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
  updateEvent(calendarId: string, eventId: string, event: CalendarEvent): Promise<CalendarEvent>;
}

export interface CalendarPolicy {
  primaryCalendarId: string;
  managedCalendarId: string;
}

export class CalendarPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarPolicyError";
  }
}

export class CalendarApiError extends Error {
  constructor(public readonly status: number) {
    super(`Google Calendar request failed with status ${status}.`);
    this.name = "CalendarApiError";
  }
}

export class GoogleAuthUnavailableError extends Error {
  constructor() {
    super("Google Calendar authentication is unavailable.");
    this.name = "GoogleAuthUnavailableError";
  }
}

export interface GoogleTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GoogleOAuthTokenProvider implements GoogleTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly loadCredentials: () => Promise<GoogleOAuthCredentials>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    try {
      const credentials = await this.loadCredentials();
      if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
        throw new Error("missing credentials");
      }
      const body = new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      });
      const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) throw new Error("refresh rejected");
      const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
      if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
        throw new Error("invalid refresh response");
      }
      this.cached = {
        token: payload.access_token,
        expiresAt: this.now() + Math.max(0, payload.expires_in) * 1000,
      };
      return this.cached.token;
    } catch {
      this.cached = undefined;
      throw new GoogleAuthUnavailableError();
    }
  }
}

function assertRange(start: string, end: string, maximumDays?: number): void {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new CalendarPolicyError("Calendar range must contain valid timestamps with end after start.");
  }
  if (maximumDays !== undefined && endMs - startMs > maximumDays * 86_400_000) {
    throw new CalendarPolicyError(`Calendar range cannot exceed ${maximumDays} days.`);
  }
}

function assertSafeText(value: string, field: string, maxLength: number): void {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new CalendarPolicyError(`${field} must be between 1 and ${maxLength} characters.`);
  }
}

export class JarvisCalendarService {
  constructor(
    private readonly client: GoogleCalendarClient,
    private readonly policy: CalendarPolicy,
    private readonly log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    if (!policy.primaryCalendarId || !policy.managedCalendarId) {
      throw new CalendarPolicyError("Both primary and managed calendar IDs are required.");
    }
    if (policy.primaryCalendarId === policy.managedCalendarId) {
      throw new CalendarPolicyError("The managed calendar must be separate from the primary calendar.");
    }
  }

  async readAgendaRange(input: { start: string; end: string }): Promise<CalendarEvent[]> {
    assertRange(input.start, input.end, 31);
    const rangeHours = Math.ceil((Date.parse(input.end) - Date.parse(input.start)) / 3_600_000);
    this.log(`CALENDAR_AGENDA_START range_hours=${rangeHours}`);
    try {
      const [primaryEvents, managedEvents] = await Promise.all([
        this.client.listAgenda(this.policy.primaryCalendarId, input.start, input.end, true),
        this.client.listAgenda(this.policy.managedCalendarId, input.start, input.end),
      ]);
      const events = [...primaryEvents, ...managedEvents].sort((left, right) => left.start.localeCompare(right.start));
      this.log(`CALENDAR_AGENDA_SUCCESS count=${events.length}`);
      return events;
    } catch (error) {
      const code = error instanceof CalendarApiError ? `api_${error.status}` : error instanceof GoogleAuthUnavailableError ? "auth_unavailable" : "unexpected";
      this.log(`CALENDAR_AGENDA_FAILURE code=${code}`);
      throw error;
    }
  }

  async readBusyRange(input: { start: string; end: string }): Promise<CalendarEvent[]> {
    assertRange(input.start, input.end);
    return this.client.queryFreeBusy(
      [this.policy.primaryCalendarId, this.policy.managedCalendarId],
      input.start,
      input.end,
    );
  }

  async createFlexibleBlock(input: {
    blockId: string;
    summary: string;
    description?: string;
    start: string;
    end: string;
  }): Promise<CalendarEvent> {
    assertRange(input.start, input.end);
    assertSafeText(input.blockId, "blockId", 128);
    assertSafeText(input.summary, "summary", 200);
    const event: CalendarEvent = {
      summary: input.summary.trim(),
      start: input.start,
      end: input.end,
      extendedProperties: {
        private: { jarvisManaged: "true", jarvisBlockId: input.blockId },
      },
    };
    if (input.description !== undefined) event.description = input.description.slice(0, 2000);
    return this.client.insertEvent(this.policy.managedCalendarId, event);
  }

  async rescheduleManagedBlock(input: {
    eventId: string;
    blockId: string;
    start: string;
    end: string;
  }): Promise<CalendarEvent> {
    assertRange(input.start, input.end);
    assertSafeText(input.eventId, "eventId", 256);
    assertSafeText(input.blockId, "blockId", 128);
    const current = await this.client.getEvent(this.policy.managedCalendarId, input.eventId);
    const markers = current.extendedProperties?.private;
    if (markers?.jarvisManaged !== "true" || markers.jarvisBlockId !== input.blockId || markers.jarvisProtected === "true") {
      throw new CalendarPolicyError("Refusing to modify an event that is not owned by this Jarvis block.");
    }
    const updated: CalendarEvent = {
      ...(current.id ? { id: current.id } : {}),
      summary: current.summary,
      ...(current.description ? { description: current.description } : {}),
      start: input.start,
      end: input.end,
      extendedProperties: {
        private: { jarvisManaged: "true", jarvisBlockId: input.blockId },
      },
    };
    return this.client.updateEvent(this.policy.managedCalendarId, input.eventId, updated);
  }

  async persistAcademicEvent(input: {
    uid: string;
    summary: string;
    start: string;
    end: string;
  }): Promise<CalendarEvent> {
    assertRange(input.start, input.end);
    assertSafeText(input.uid, "uid", 1024);
    assertSafeText(input.summary, "summary", 200);
    const eventId = `academic${createHash("sha256").update(input.uid).digest("hex").slice(0, 32)}`;
    const event: CalendarEvent = {
      id: eventId,
      summary: input.summary.trim(),
      start: input.start,
      end: input.end,
      extendedProperties: {
        private: {
          jarvisManaged: "true",
          jarvisBlockId: eventId,
          jarvisProtected: "true",
        },
      },
    };
    try {
      const current = await this.client.getEvent(this.policy.managedCalendarId, eventId);
      const markers = current.extendedProperties?.private;
      if (markers?.jarvisManaged !== "true" || markers.jarvisBlockId !== eventId || markers.jarvisProtected !== "true") {
        throw new CalendarPolicyError("Refusing to replace an academic event without exact ownership markers.");
      }
      return this.client.updateEvent(this.policy.managedCalendarId, eventId, event);
    } catch (error) {
      if (error instanceof CalendarApiError && error.status === 404) {
        return this.client.insertEvent(this.policy.managedCalendarId, event);
      }
      throw error;
    }
  }
}

interface GoogleEventWire {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  attendees?: Array<{ email: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendarRestClient implements GoogleCalendarClient {
  constructor(
    private readonly tokenProvider: GoogleTokenProvider,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T = GoogleEventWire>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.tokenProvider.getAccessToken();
    const response = await this.fetchFn(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new CalendarApiError(response.status);
    return (await response.json()) as T;
  }

  async queryFreeBusy(calendarIds: string[], start: string, end: string): Promise<CalendarEvent[]> {
    if (calendarIds.length < 1 || calendarIds.length > 50 || new Set(calendarIds).size !== calendarIds.length) {
      throw new CalendarPolicyError("Free/busy queries require between 1 and 50 distinct calendar IDs.");
    }
    const response = await this.request<{
      calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: unknown[] }>;
    }>("/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: start, timeMax: end, timeZone: "America/Bogota", items: calendarIds.map((id) => ({ id })) }),
    });
    return calendarIds.flatMap((calendarId) => {
      const calendar = response.calendars?.[calendarId];
      if (!calendar || (calendar.errors?.length ?? 0) > 0) throw new CalendarApiError(502);
      return (calendar.busy ?? []).flatMap((period, index) => {
        if (!period.start || !period.end) return [];
        return [{ id: `busy-${calendarId}-${index}`, summary: "Busy", start: period.start, end: period.end }];
      });
    });
  }

  async listAgenda(calendarId: string, start: string, end: string, includeDescription = false): Promise<CalendarEvent[]> {
    assertRange(start, end, 31);
    assertSafeText(calendarId, "calendarId", 1024);
    const result: CalendarEvent[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({
        timeMin: start,
        timeMax: end,
        singleEvents: "true",
        orderBy: "startTime",
        showDeleted: "false",
        maxResults: "250",
        fields: includeDescription
          ? "items(id,summary,description,start,end,location),nextPageToken"
          : "items(id,summary,start,end,location),nextPageToken",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request<{ items?: GoogleEventWire[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
      );
      for (const wire of response.items ?? []) result.push(fromAgendaWire(wire, includeDescription));
      const next = response.nextPageToken?.trim();
      if (!next) return result;
      if (seenTokens.has(next)) throw new CalendarApiError(502);
      seenTokens.add(next);
      pageToken = next;
    }
    throw new CalendarPolicyError("Calendar agenda pagination exceeded the 10-page safety limit.");
  }

  async insertEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent> {
    const wire = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
      method: "POST",
      body: JSON.stringify(toWire(event)),
    });
    return fromWire(wire);
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    return fromWire(await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`));
  }

  async updateEvent(calendarId: string, eventId: string, event: CalendarEvent): Promise<CalendarEvent> {
    const wire = await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "PUT",
      body: JSON.stringify(toWire(event)),
    });
    return fromWire(wire);
  }
}

function toWire(event: CalendarEvent): GoogleEventWire {
  return {
    ...(event.id ? { id: event.id } : {}),
    summary: event.summary,
    ...(event.description ? { description: event.description } : {}),
    start: { dateTime: event.start, timeZone: "America/Bogota" } as { dateTime: string },
    end: { dateTime: event.end, timeZone: "America/Bogota" } as { dateTime: string },
    ...(event.extendedProperties ? { extendedProperties: event.extendedProperties } : {}),
  };
}

function fromWire(event: GoogleEventWire): CalendarEvent {
  const start = event.start?.dateTime ?? allDayBoundary(event.start?.date);
  const end = event.end?.dateTime ?? allDayBoundary(event.end?.date);
  if (!start || !end) throw new CalendarPolicyError("Google Calendar returned an incomplete event.");
  return {
    ...(event.id ? { id: event.id } : {}),
    summary: event.summary ?? "Untitled",
    ...(event.description ? { description: event.description } : {}),
    start,
    end,
    ...(event.extendedProperties ? { extendedProperties: event.extendedProperties } : {}),
  };
}

function fromAgendaWire(event: GoogleEventWire, includeDescription: boolean): CalendarEvent {
  const full = fromWire(event);
  return {
    ...(full.id ? { id: full.id } : {}),
    summary: full.summary,
    ...(includeDescription && typeof event.description === "string" && event.description.trim()
      ? { description: event.description }
      : {}),
    start: full.start,
    end: full.end,
    ...(typeof event.location === "string" && event.location.trim() ? { location: event.location.trim().slice(0, 500) } : {}),
  };
}

function allDayBoundary(date: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return `${date}T00:00:00-05:00`;
}
