import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CalendarApiError,
  CalendarPolicyError,
  GoogleAuthUnavailableError,
  GoogleCalendarRestClient,
  GoogleOAuthTokenProvider,
  JarvisCalendarService,
  type CalendarEvent,
  type GoogleCalendarClient,
} from "../plugins/jarvis-tools/src/calendar.js";

class FakeCalendarClient implements GoogleCalendarClient {
  public calls: Array<{ op: string; calendarId: string; body?: unknown }> = [];
  public event: CalendarEvent | undefined;

  async queryFreeBusy(calendarIds: string[], start: string, end: string): Promise<CalendarEvent[]> {
    this.calls.push({ op: "freebusy", calendarId: calendarIds.join(","), body: { start, end } });
    return calendarIds.map((calendarId, index) => ({ id: `busy-${index}`, summary: "Busy", start, end, description: calendarId }));
  }
  async listAgenda(calendarId: string, start: string, end: string, includeDescription = false): Promise<CalendarEvent[]> {
    this.calls.push({ op: "agenda", calendarId, body: { start, end, includeDescription } });
    return [{
      id: calendarId === "primary" ? "primary-1" : "managed-1",
      summary: calendarId === "primary" ? "Consulta médica" : "EDO",
      ...(includeDescription ? { description: "Traer resultados" } : {}),
      start,
      end,
      location: calendarId === "primary" ? "Consultorio 3" : "Aula 201",
    }];
  }
  async insertEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent> {
    this.calls.push({ op: "insert", calendarId, body: event });
    return { ...event, id: "managed-1" };
  }
  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    this.calls.push({ op: "get", calendarId, body: eventId });
    if (!this.event) throw new CalendarApiError(404);
    return this.event;
  }
  async updateEvent(calendarId: string, eventId: string, event: CalendarEvent): Promise<CalendarEvent> {
    this.calls.push({ op: "update", calendarId, body: { eventId, event } });
    return { ...event, id: eventId };
  }
}

const policy = { primaryCalendarId: "primary", managedCalendarId: "jarvis-plan" };

describe("JarvisCalendarService", () => {
  it("merges busy intervals from primary and managed calendars", async () => {
    const client = new FakeCalendarClient();
    const service = new JarvisCalendarService(client, policy);
    const events = await service.readBusyRange({
      start: "2026-09-07T00:00:00-05:00",
      end: "2026-09-08T00:00:00-05:00",
    });
    assert.equal(events.length, 2);
    assert.equal(client.calls[0]?.calendarId, "primary,jarvis-plan");
  });

  it("reads a bounded agenda from the primary and managed calendars without exposing event data in lifecycle logs", async () => {
    const client = new FakeCalendarClient();
    const logs: string[] = [];
    const service = new JarvisCalendarService(client, policy, (line) => logs.push(line));
    const events = await service.readAgendaRange({
      start: "2026-09-09T00:00:00-05:00",
      end: "2026-09-10T00:00:00-05:00",
    });
    assert.deepEqual(events, [
      { id: "primary-1", summary: "Consulta médica", description: "Traer resultados", start: "2026-09-09T00:00:00-05:00", end: "2026-09-10T00:00:00-05:00", location: "Consultorio 3" },
      { id: "managed-1", summary: "EDO", start: "2026-09-09T00:00:00-05:00", end: "2026-09-10T00:00:00-05:00", location: "Aula 201" },
    ]);
    assert.deepEqual(client.calls.map(({ op, calendarId }) => ({ op, calendarId })), [
      { op: "agenda", calendarId: "primary" },
      { op: "agenda", calendarId: "jarvis-plan" },
    ]);
    assert.deepEqual(client.calls.map(({ body }) => body), [
      { start: "2026-09-09T00:00:00-05:00", end: "2026-09-10T00:00:00-05:00", includeDescription: true },
      { start: "2026-09-09T00:00:00-05:00", end: "2026-09-10T00:00:00-05:00", includeDescription: false },
    ]);
    assert.equal(client.calls.some((call) => call.calendarId === "primary" && ["insert", "get", "update"].includes(call.op)), false);
    assert.match(logs[0] ?? "", /^CALENDAR_AGENDA_START /);
    assert.match(logs[1] ?? "", /^CALENDAR_AGENDA_SUCCESS count=2$/);
    assert.doesNotMatch(logs.join("\n"), /EDO|Aula|jarvis-plan|primary-1|Consulta|resultados|Consultorio/);
    await assert.rejects(service.readAgendaRange({
      start: "2026-09-01T00:00:00-05:00",
      end: "2026-10-03T00:00:00-05:00",
    }), /31 days/i);
  });

  it("creates only marker-tagged events in the managed calendar", async () => {
    const client = new FakeCalendarClient();
    const service = new JarvisCalendarService(client, policy);
    const event = await service.createFlexibleBlock({
      blockId: "study-mon",
      summary: "Estudio profundo",
      start: "2026-09-07T10:15:00-05:00",
      end: "2026-09-07T12:15:00-05:00",
    });
    assert.equal(client.calls[0]?.calendarId, "jarvis-plan");
    assert.deepEqual(event.extendedProperties?.private, {
      jarvisManaged: "true",
      jarvisBlockId: "study-mon",
    });
    assert.equal(event.attendees, undefined);
  });

  it("refuses to reschedule events without both managed markers", async () => {
    const client = new FakeCalendarClient();
    client.event = {
      id: "foreign",
      summary: "Exam",
      start: "2026-09-08T08:00:00-05:00",
      end: "2026-09-08T10:00:00-05:00",
    };
    const service = new JarvisCalendarService(client, policy);
    await assert.rejects(
      service.rescheduleManagedBlock({
        eventId: "foreign",
        blockId: "study-mon",
        start: "2026-09-08T10:00:00-05:00",
        end: "2026-09-08T12:00:00-05:00",
      }),
      CalendarPolicyError,
    );
    assert.equal(client.calls.some((call) => call.op === "update"), false);
  });

  it("refuses a mismatched block id even on managed events", async () => {
    const client = new FakeCalendarClient();
    client.event = {
      id: "managed-1",
      summary: "Study",
      start: "2026-09-08T08:00:00-05:00",
      end: "2026-09-08T10:00:00-05:00",
      extendedProperties: { private: { jarvisManaged: "true", jarvisBlockId: "other" } },
    };
    const service = new JarvisCalendarService(client, policy);
    await assert.rejects(
      service.rescheduleManagedBlock({
        eventId: "managed-1",
        blockId: "study-mon",
        start: "2026-09-08T10:00:00-05:00",
        end: "2026-09-08T12:00:00-05:00",
      }),
      CalendarPolicyError,
    );
  });

  it("persists academic events idempotently with deterministic protected markers", async () => {
    const client = new FakeCalendarClient();
    const service = new JarvisCalendarService(client, policy);
    await service.persistAcademicEvent({
      uid: "alex-1@example",
      summary: "Circuits",
      start: "2026-09-07T08:00:00-05:00",
      end: "2026-09-07T10:00:00-05:00",
    });
    const inserted = client.calls.find((call) => call.op === "insert")?.body as CalendarEvent;
    assert.match(inserted.id ?? "", /^academic[0-9a-f]{32}$/);
    assert.deepEqual(inserted.extendedProperties?.private, {
      jarvisManaged: "true",
      jarvisBlockId: inserted.id,
      jarvisProtected: "true",
    });
    assert.equal(inserted.attendees, undefined);

    client.event = inserted;
    await service.persistAcademicEvent({
      uid: "alex-1@example",
      summary: "Circuits",
      start: "2026-09-07T08:00:00-05:00",
      end: "2026-09-07T10:00:00-05:00",
    });
    assert.equal(client.calls.filter((call) => call.op === "insert").length, 1);
    assert.equal(client.calls.filter((call) => call.op === "update").length, 1);
  });

  it("maps Google FreeBusy periods without requesting event details", async () => {
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
      calendars: { primary: { busy: [{ start: "2026-09-07T05:00:00Z", end: "2026-09-08T05:00:00Z" }] } },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = new GoogleCalendarRestClient({ getAccessToken: async () => "token" }, fetchFn);
    const events = await client.queryFreeBusy(["primary"], "2026-09-07T00:00:00-05:00", "2026-09-09T00:00:00-05:00");
    assert.equal(events[0]?.start, "2026-09-07T05:00:00Z");
    assert.equal(events[0]?.end, "2026-09-08T05:00:00Z");
  });

  it("paginates Events.list with minimized fields and exposes descriptions only when requested", async () => {
    const urls: URL[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      const page = url.searchParams.get("pageToken");
      return new Response(JSON.stringify(page === null ? {
        items: [{ id: "one", summary: "Circuitos", start: { dateTime: "2026-09-09T08:00:00-05:00" }, end: { dateTime: "2026-09-09T10:00:00-05:00" }, location: "B-201", description: "private" }],
        nextPageToken: "next-token",
      } : {
        items: [{ id: "two", summary: "EDO", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new GoogleCalendarRestClient({ getAccessToken: async () => "token" }, fetchFn);
    const events = await client.listAgenda("primary", "2026-09-09T00:00:00-05:00", "2026-09-12T00:00:00-05:00", true);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { id: "one", summary: "Circuitos", description: "private", start: "2026-09-09T08:00:00-05:00", end: "2026-09-09T10:00:00-05:00", location: "B-201" });
    assert.equal(urls.length, 2);
    for (const url of urls) {
      assert.equal(url.searchParams.get("singleEvents"), "true");
      assert.equal(url.searchParams.get("orderBy"), "startTime");
      assert.equal(url.searchParams.get("maxResults"), "250");
      assert.equal(url.searchParams.get("fields"), "items(id,summary,description,start,end,location),nextPageToken");
      assert.match(url.pathname, /primary/);
    }
    assert.equal(urls[1]?.searchParams.get("pageToken"), "next-token");
  });

  it("omits descriptions from managed agenda responses even if Google returns them", async () => {
    let requestUrl: URL | undefined;
    const client = new GoogleCalendarRestClient({ getAccessToken: async () => "token" }, async (input) => {
      requestUrl = new URL(String(input));
      return new Response(JSON.stringify({
        items: [{ id: "managed", summary: "Jarvis block", description: "not returned", start: { dateTime: "2026-09-09T08:00:00-05:00" }, end: { dateTime: "2026-09-09T09:00:00-05:00" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const events = await client.listAgenda("jarvis-plan", "2026-09-09T00:00:00-05:00", "2026-09-10T00:00:00-05:00");
    assert.deepEqual(events, [{ id: "managed", summary: "Jarvis block", start: "2026-09-09T08:00:00-05:00", end: "2026-09-09T09:00:00-05:00" }]);
    assert.equal(requestUrl?.searchParams.get("fields"), "items(id,summary,start,end,location),nextPageToken");
  });

  it("refreshes OAuth access tokens and fails closed when refresh is unavailable", async () => {
    let refreshCalls = 0;
    const provider = new GoogleOAuthTokenProvider(async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }), async (_url, init) => {
      refreshCalls += 1;
      assert.doesNotMatch(String(init?.body), /undefined/);
      return new Response(JSON.stringify({ access_token: "short-lived", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    assert.equal(await provider.getAccessToken(), "short-lived");
    assert.equal(await provider.getAccessToken(), "short-lived");
    assert.equal(refreshCalls, 1);

    const unavailable = new GoogleOAuthTokenProvider(async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }), async () => new Response("denied", { status: 400 }));
    await assert.rejects(unavailable.getAccessToken(), GoogleAuthUnavailableError);

    const calendarFetch: typeof fetch = async () => { throw new Error("must not call calendar API"); };
    const client = new GoogleCalendarRestClient(unavailable, calendarFetch);
    await assert.rejects(client.queryFreeBusy(["primary"], "2026-09-07T00:00:00-05:00", "2026-09-08T00:00:00-05:00"), GoogleAuthUnavailableError);
  });
});
