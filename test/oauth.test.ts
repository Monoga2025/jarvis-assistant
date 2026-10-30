import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_JARVIS_SCOPES,
  buildAuthorizationUrl,
  createManagedCalendar,
  createPkce,
  exchangeAuthorizationCode,
  formatGoogleReadFailure,
  recoverTasksAndWriteDeferredCalendarEnv,
  parseOAuthCliOptions,
  reconcileTasksBeforeCalendarVerification,
  validateOAuthCallback,
  writeRailwayCalendarEnv,
  verifyManagedCalendar,
  resolveManagedTaskList,
} from "../scripts/google-calendar-oauth.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Google Calendar desktop OAuth bootstrap", () => {
  it("uses exact narrow scopes, loopback redirect, state, and S256 PKCE", () => {
    assert.deepEqual(GOOGLE_CALENDAR_SCOPES, [
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
    ]);
    const pkce = createPkce(Buffer.alloc(64, 7));
    assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
    const url = new URL(buildAuthorizationUrl({
      clientId: "desktop-client",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      state: "expected-state",
      challenge: pkce.challenge,
    }));
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:43123/oauth/callback");
    assert.equal(url.searchParams.get("state"), "expected-state");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(url.searchParams.get("scope")?.split(" "), GOOGLE_JARVIS_SCOPES);
    assert.deepEqual(GOOGLE_JARVIS_SCOPES, [...GOOGLE_CALENDAR_SCOPES, "https://www.googleapis.com/auth/tasks"]);
  });

  it("rejects callback state mismatch and token scope widening or loss", async () => {
    assert.throws(() => validateOAuthCallback(new URL("http://127.0.0.1/oauth/callback?code=x&state=wrong"), "right"));
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
      access_token: "temporary",
      refresh_token: "refresh",
      scope: GOOGLE_CALENDAR_SCOPES[0],
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(exchangeAuthorizationCode({
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      code: "authorization-code",
      verifier: createPkce(Buffer.alloc(64, 8)).verifier,
      fetchFn,
    }), /scopes/i);
  });

  it("reports only the OAuth status and allowlisted machine error on token-exchange failures", async () => {
    const input = {
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      redirectUri: "http://127.0.0.1:43123/oauth/callback",
      code: "authorization-code",
      verifier: createPkce(Buffer.alloc(64, 9)).verifier,
    };
    const assertFailure = async (response: Response, expected: RegExp) => {
      await assert.rejects(exchangeAuthorizationCode({ ...input, fetchFn: async () => response }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /authorization-code|desktop-secret|expected-state|code-verifier|Bearer|refresh-token|access-token|leak-me|do not disclose/i);
        return true;
      });
    };

    await assertFailure(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "authorization-code refresh-token Bearer do not disclose",
      arbitrary: "leak-me",
    }), { status: 400, headers: { "content-type": "application/json" } }), /status 400.*invalid_grant/i);
    await assertFailure(new Response("authorization-code refresh-token", { status: 400 }), /^OAuth token exchange failed with status 400\.$/);
    await assertFailure(new Response(JSON.stringify({ error: { code: "invalid_grant", message: "leak-me" } }), { status: 400 }), /^OAuth token exchange failed with status 400\.$/);
  });

  it("writes a git-ignored operator artifact with restrictive permissions without returning secrets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(directory);
    const output = path.join(directory, ".env.jarvis-calendar");
    const result = await writeRailwayCalendarEnv(output, {
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      refreshToken: "refresh-secret",
      managedCalendarId: "managed-id",
      taskListId: "dedicated-list",
    });
    assert.deepEqual(result, { outputPath: output, managedCalendarId: "managed-id", taskListId: "dedicated-list" });
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
    const contents = await readFile(output, "utf8");
    assert.match(contents, /^JARVIS_CALENDAR_ENABLED=false$/m);
    assert.match(contents, /^GOOGLE_MANAGED_CALENDAR_ID=managed-id$/m);
    assert.match(contents, /^GOOGLE_TASKS_LIST_ID=dedicated-list$/m);
    assert.match(contents, /^JARVIS_TASKS_ENABLED=false$/m);
  });

  it("reauthorizes an exact owned calendar through Calendar and metadata-only Events GETs, never CalendarList", async () => {
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (url, options) => {
      assert.equal(options?.method ?? "GET", "GET");
      const requestUrl = String(url);
      requests.push(requestUrl);
      if (requestUrl.includes("calendarList")) throw new Error("CalendarList must not be called");
      if (requestUrl.includes("/events?")) return Response.json({ accessRole: "owner" });
      if (requestUrl.includes("calendar/v3/calendars/")) return Response.json({ id: "managed@example.com" });
      return Response.json({ id: "dedicated-list", title: "Renamed by owner" });
    };
    assert.equal(await verifyManagedCalendar("temporary", "managed@example.com", fetchFn), "managed@example.com");
    assert.equal(await resolveManagedTaskList({ accessToken: "temporary", managedCalendarId: "managed@example.com", taskListId: "dedicated-list", fetchFn }), "dedicated-list");
    assert.equal(requests.length, 3);
    assert.match(requests[0]!, /managed%40example.com/);
    assert.match(requests[1]!, /\/events\?maxResults=1&fields=accessRole$/);
    assert.ok(requests.every((request) => !request.includes("calendarList")));
  });

  it("creates one dedicated Jarvis Plan calendar with the narrow OAuth token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (url, init) => {
      requests.push(init ? { url: String(url), init } : { url: String(url) });
      return Response.json({ id: "jarvis-plan@example.com" });
    };
    assert.equal(await createManagedCalendar("temporary", fetchFn), "jarvis-plan@example.com");
    assert.deepEqual(requests, [{
      url: "https://www.googleapis.com/calendar/v3/calendars",
      init: {
        method: "POST",
        headers: { authorization: "Bearer temporary", "content-type": "application/json" },
        body: JSON.stringify({ summary: "Jarvis Plan", timeZone: "America/Bogota" }),
      },
    }]);
  });

  it("requires exactly one managed-calendar provisioning mode", () => {
    const base = ["--client", "desktop-client.json", "--create-tasks-list"];
    assert.deepEqual(parseOAuthCliOptions([...base, "--create-managed-calendar"]), {
      clientPath: "desktop-client.json",
      outputPath: ".env.jarvis-calendar",
      createManagedCalendar: true,
      createList: true,
    });
    assert.throws(() => parseOAuthCliOptions([...base, "--managed-calendar-id", "managed", "--create-managed-calendar"]), /exactly one/i);
    assert.throws(() => parseOAuthCliOptions(base), /exactly one/i);
  });

  it("requires an explicit, exclusive receipt directory before reconciling a task list", () => {
    const base = ["--client", "desktop-client.json", "--managed-calendar-id", "managed"];
    assert.deepEqual(parseOAuthCliOptions([...base, "--reconcile-tasks-receipt", "private-receipt"]), {
      clientPath: "desktop-client.json",
      outputPath: ".env.jarvis-calendar",
      managedCalendarId: "managed",
      createManagedCalendar: false,
      createList: false,
      reconcileTasksReceiptDirectory: "private-receipt",
    });
    assert.throws(() => parseOAuthCliOptions([...base, "--reconcile-tasks-receipt", "private-receipt", "--tasks-list-id", "existing"]), /exactly one/i);
    assert.throws(() => parseOAuthCliOptions([...base, "--reconcile-tasks-receipt", "private-receipt", "--create-tasks-list"]), /exactly one/i);
    assert.deepEqual(parseOAuthCliOptions([...base, "--reconcile-tasks-receipt", "private-receipt", "--create-tasks-list-if-none"]), {
      clientPath: "desktop-client.json",
      outputPath: ".env.jarvis-calendar",
      managedCalendarId: "managed",
      createManagedCalendar: false,
      createList: false,
      reconcileTasksReceiptDirectory: "private-receipt",
      createWhenNoExactTitleMatch: true,
    });
    assert.throws(() => parseOAuthCliOptions([...base, "--create-tasks-list-if-none", "--tasks-list-id", "existing"]), /requires/i);
    assert.throws(() => parseOAuthCliOptions(["--client", "desktop-client.json", "--create-managed-calendar", "--reconcile-tasks-receipt", "private-receipt"]), /managed-calendar-id/i);
  });

  it("permits deferred Calendar verification only for the bound task-receipt recovery path", () => {
    const base = ["--client", "desktop-client.json", "--managed-calendar-id", "managed", "--reconcile-tasks-receipt", "private-receipt"];
    assert.deepEqual(parseOAuthCliOptions([...base, "--defer-calendar-verification"]), {
      clientPath: "desktop-client.json",
      outputPath: ".env.jarvis-calendar",
      managedCalendarId: "managed",
      createManagedCalendar: false,
      createList: false,
      reconcileTasksReceiptDirectory: "private-receipt",
      deferCalendarVerification: true,
    });
    assert.throws(() => parseOAuthCliOptions(["--client", "desktop-client.json", "--create-managed-calendar", "--create-tasks-list", "--defer-calendar-verification"]), /reconciliation/i);
    assert.throws(() => parseOAuthCliOptions(["--client", "desktop-client.json", "--managed-calendar-id", "managed", "--tasks-list-id", "list", "--defer-calendar-verification"]), /reconciliation/i);
  });

  it("writes disabled runtime credentials only after verified receipt recovery without fetching Calendar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    const outputPath = path.join(root, ".env.jarvis-calendar");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const requests: string[] = [];

    await recoverTasksAndWriteDeferredCalendarEnv({
      accessToken: "temporary",
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      refreshToken: "refresh-secret",
      managedCalendarId: "managed",
      receiptDirectory,
      outputPath,
      fetchFn: async (url) => {
        const request = String(url);
        requests.push(request);
        if (request.includes("calendar")) throw new Error("Calendar must not be fetched in deferred mode");
        if (request.includes("users/@me/lists?")) return Response.json({ items: [{ id: "reconciled-list", title: "Jarvis Tasks" }] });
        if (request.includes("/lists/reconciled-list?")) return Response.json({ id: "reconciled-list" });
        throw new Error(`Unexpected request: ${request}`);
      },
    });

    assert.equal(requests.length, 2);
    const contents = await readFile(outputPath, "utf8");
    assert.match(contents, /^JARVIS_CALENDAR_ENABLED=false$/m);
    assert.match(contents, /^JARVIS_TASKS_ENABLED=false$/m);
    assert.deepEqual(JSON.parse(await readFile(path.join(receiptDirectory, "created.json"), "utf8")), {
      formatVersion: 1,
      managedCalendarId: "managed",
      taskListId: "reconciled-list",
    });
  });

  it("does not write deferred credentials when receipt task verification fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    const outputPath = path.join(root, ".env.jarvis-calendar");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });

    await assert.rejects(recoverTasksAndWriteDeferredCalendarEnv({
      accessToken: "temporary",
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      refreshToken: "refresh-secret",
      managedCalendarId: "managed",
      receiptDirectory,
      outputPath,
      fetchFn: async () => new Response("no task access", { status: 403 }),
    }), /status 403/);
    await assert.rejects(readFile(outputPath, "utf8"), /ENOENT/);
  });

  it("rejects primary aliases, non-owner calendars, mismatched IDs and inaccessible targets", async () => {
    const neverFetch: typeof fetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(verifyManagedCalendar("temporary", "primary", neverFetch), /primary/i);
    for (const responses of [
      [{ id: "different" }],
      [{ id: "managed" }, { accessRole: "writer" }],
    ]) {
      let index = 0;
      await assert.rejects(verifyManagedCalendar("temporary", "managed", async () => Response.json(responses[index++])), /target|owner/i);
    }
    await assert.rejects(verifyManagedCalendar("temporary", "managed", async () => new Response("secret body", { status: 403 })), /status 403/);
    const ownershipRequests: string[] = [];
    await assert.rejects(verifyManagedCalendar("temporary", "managed", async (url) => {
      const requestUrl = String(url);
      ownershipRequests.push(requestUrl);
      if (requestUrl.includes("/events?")) return new Response("secret ownership response", { status: 403 });
      return Response.json({ id: "managed" });
    }), /status 403/);
    assert.deepEqual(ownershipRequests.length, 2);
    assert.match(ownershipRequests[1]!, /\/events\?maxResults=1&fields=accessRole$/);
    assert.ok(ownershipRequests.every((request) => !request.includes("calendarList")));
    await assert.rejects(resolveManagedTaskList({ accessToken: "temporary", managedCalendarId: "managed", taskListId: "@default", fetchFn: neverFetch }), /dedicated/i);
    await assert.rejects(resolveManagedTaskList({ accessToken: "temporary", managedCalendarId: "managed", taskListId: "one", fetchFn: async () => Response.json({ id: "two" }) }), /mismatch/i);
  });

  it("creates a dedicated list only with explicit intent and a durable receipt, then reuses it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    const methods: string[] = [];
    const options = { accessToken: "do-not-persist-token", managedCalendarId: "managed", receiptDirectory,
      fetchFn: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({ id: "created-list" });
      } };
    assert.equal(await resolveManagedTaskList(options), "created-list");
    assert.equal(await resolveManagedTaskList(options), "created-list");
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.ok(!(await readFile(path.join(receiptDirectory, "created.json"), "utf8")).includes(options.accessToken));
    await assert.rejects(resolveManagedTaskList({ ...options, managedCalendarId: "another-calendar" }), /binding/i);
  });

  it("does not retry a list creation with an unknown remote outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    let calls = 0;
    const options = { accessToken: "temporary", managedCalendarId: "managed", receiptDirectory: path.join(root, "provisioning"),
      fetchFn: async () => { calls++; throw new Error("network response lost"); } };
    await assert.rejects(resolveManagedTaskList(options), /unknown outcome/i);
    await assert.rejects(resolveManagedTaskList(options), /unknown outcome/i);
    assert.equal(calls, 1);
    await assert.rejects(resolveManagedTaskList({ accessToken: "temporary", managedCalendarId: "managed", fetchFn: options.fetchFn }), /explicit/i);
  });

  it("reconciles exactly one Jarvis Tasks list from a matching pending receipt without mutating Google", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const requests: Array<{ url: string; method: string }> = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const request = { url: String(url), method: init?.method ?? "GET" };
      requests.push(request);
      if (request.url.includes("/events?")) return Response.json({ accessRole: "owner" });
      if (request.url.includes("calendar/v3/calendars/")) return Response.json({ id: "managed" });
      if (request.url.includes("users/@me/lists?")) return Response.json({ items: [{ id: "other", title: "Jarvis Tasks " }, { id: "reconciled-list", title: "Jarvis Tasks" }] });
      if (request.url.includes("/lists/reconciled-list?")) return Response.json({ id: "reconciled-list" });
      throw new Error(`Unexpected request: ${request.url}`);
    };
    const managedCalendarId = await verifyManagedCalendar("temporary", "managed", fetchFn);
    assert.equal(await resolveManagedTaskList({ accessToken: "temporary", managedCalendarId, reconcileReceiptDirectory: receiptDirectory, fetchFn }), "reconciled-list");
    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET", "GET"]);
    assert.ok(requests.some((request) => request.url.includes("users/@me/lists?")));
    assert.deepEqual(JSON.parse(await readFile(path.join(receiptDirectory, "created.json"), "utf8")), {
      formatVersion: 1,
      managedCalendarId: "managed",
      taskListId: "reconciled-list",
    });
  });

  it("recovers a pending task receipt before Calendar verification and retains it after a Calendar 401", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const requests: Array<{ url: string; method: string }> = [];

    await assert.rejects(reconcileTasksBeforeCalendarVerification({
      accessToken: "temporary",
      managedCalendarId: "managed",
      receiptDirectory,
      fetchFn: async (url, init) => {
        const request = { url: String(url), method: init?.method ?? "GET" };
        requests.push(request);
        if (request.url.includes("users/@me/lists?")) return Response.json({ items: [{ id: "reconciled-list", title: "Jarvis Tasks" }] });
        if (request.url.includes("/lists/reconciled-list?")) return Response.json({ id: "reconciled-list" });
        if (request.url.includes("calendar/v3/calendars/")) return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED", errors: [{ reason: "authError" }], message: "secret calendar failure" } }), { status: 401 });
        throw new Error(`Unexpected request: ${request.url}`);
      },
    }), /status 401/);

    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET"]);
    assert.match(requests[0]!.url, /tasks\.googleapis\.com/);
    assert.match(requests[1]!.url, /tasks\.googleapis\.com/);
    assert.match(requests[2]!.url, /calendar\/v3\/calendars\//);
    assert.ok(requests.every((request) => !request.url.includes("calendarList")));
    assert.deepEqual(JSON.parse(await readFile(path.join(receiptDirectory, "created.json"), "utf8")), {
      formatVersion: 1,
      managedCalendarId: "managed",
      taskListId: "reconciled-list",
    });
  });

  it("does not finalize a reconciliation receipt until the selected task list GET succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const methods: string[] = [];

    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      fetchFn: async (url, init) => {
        methods.push(init?.method ?? "GET");
        if (String(url).includes("users/@me/lists?")) return Response.json({ items: [{ id: "reconciled-list", title: "Jarvis Tasks" }] });
        return new Response("secret task response", { status: 403 });
      },
    }), /status 403/);
    assert.deepEqual(methods, ["GET", "GET"]);
    await assert.rejects(readFile(path.join(receiptDirectory, "created.json"), "utf8"), /ENOENT/);
  });

  it("redacts Calendar and Tasks read errors to status and allowlisted Google fields", async () => {
    const error = await formatGoogleReadFailure("Calendar", new Response(JSON.stringify({
      error: {
        status: "UNAUTHENTICATED",
        message: "authorization-code refresh-token Bearer secret",
        errors: [{ reason: "authError", message: "do not disclose" }],
      },
      arbitrary: "leak-me",
    }), { status: 401 }));
    assert.match(error.message, /status 401/);
    assert.match(error.message, /UNAUTHENTICATED/);
    assert.match(error.message, /authError/);
    assert.doesNotMatch(error.message, /authorization-code|refresh-token|Bearer|secret|disclose|leak-me/);
  });

  it("fails closed when reconciliation finds zero or multiple exact title matches", async () => {
    for (const { items, expected } of [
      { items: [], expected: /zero/i },
      { items: [{ id: "one", title: "Jarvis Tasks" }, { id: "two", title: "Jarvis Tasks" }], expected: /multiple/i },
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
      temporaryDirectories.push(root);
      const receiptDirectory = path.join(root, "provisioning");
      await mkdir(receiptDirectory, { mode: 0o700 });
      await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
      const methods: string[] = [];
      await assert.rejects(resolveManagedTaskList({
        accessToken: "temporary",
        managedCalendarId: "managed",
        reconcileReceiptDirectory: receiptDirectory,
        fetchFn: async (_url, init) => {
          methods.push(init?.method ?? "GET");
          return Response.json({ items });
        },
      }), expected);
      assert.deepEqual(methods, ["GET"]);
      await assert.rejects(readFile(path.join(receiptDirectory, "created.json"), "utf8"), /ENOENT/);
    }
  });

  it("creates exactly once after opted-in zero-match reconciliation, then verifies before finalizing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const requests: Array<{ url: string; method: string }> = [];

    const taskListId = await resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      createWhenNoExactTitleMatch: true,
      fetchFn: async (url, init) => {
        const request = { url: String(url), method: init?.method ?? "GET" };
        requests.push(request);
        if (request.url.includes("users/@me/lists?")) return Response.json({ items: [] });
        if (request.method === "POST") return Response.json({ id: "created-after-recovery" });
        if (request.url.includes("/lists/created-after-recovery?")) return Response.json({ id: "created-after-recovery", title: "Jarvis Tasks" });
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    assert.equal(taskListId, "created-after-recovery");
    assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(receiptDirectory, "created.json"), "utf8")), {
      formatVersion: 1,
      managedCalendarId: "managed",
      taskListId: "created-after-recovery",
    });
  });

  it("does not create during opted-in recovery when multiple exact titles are found", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const methods: string[] = [];

    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      createWhenNoExactTitleMatch: true,
      fetchFn: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({ items: [{ id: "one", title: "Jarvis Tasks" }, { id: "two", title: "Jarvis Tasks" }] });
      },
    }), /multiple/i);
    assert.deepEqual(methods, ["GET"]);
  });

  it("does not create a zero-match task list without the explicit recovery opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    const methods: string[] = [];

    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      fetchFn: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({ items: [] });
      },
    }), /zero/i);
    assert.deepEqual(methods, ["GET"]);
  });

  it("requires a pending receipt bound to the managed calendar before opted-in recovery lists or posts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "other-managed" }), { mode: 0o600, flag: "wx" });
    let calls = 0;

    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      createWhenNoExactTitleMatch: true,
      fetchFn: async () => { calls += 1; return Response.json({ items: [] }); },
    }), /binding/i);
    assert.equal(calls, 0);
  });

  it("idempotently reuses a valid bound created receipt during deferred reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    const outputPath = path.join(root, ".env.jarvis-calendar");
    const createdReceipt = JSON.stringify({ formatVersion: 1, managedCalendarId: "managed", taskListId: "created-list" });
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    await writeFile(path.join(receiptDirectory, "created.json"), createdReceipt, { mode: 0o600, flag: "wx" });
    const requests: Array<{ url: string; method: string }> = [];

    const result = await recoverTasksAndWriteDeferredCalendarEnv({
      accessToken: "temporary",
      clientId: "desktop-client",
      clientSecret: "desktop-secret",
      refreshToken: "refresh-secret",
      managedCalendarId: "managed",
      receiptDirectory,
      outputPath,
      fetchFn: async (url, init) => {
        const request = { url: String(url), method: init?.method ?? "GET" };
        requests.push(request);
        if (request.url.includes("/lists/created-list?")) return Response.json({ id: "created-list" });
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    assert.equal(result.taskListId, "created-list");
    assert.deepEqual(requests.map((request) => request.method), ["GET"]);
    assert.match(requests[0]!.url, /\/lists\/created-list\?/);
    assert.equal(await readFile(path.join(receiptDirectory, "created.json"), "utf8"), createdReceipt);
  });

  it("reuses a valid bound created receipt before Calendar verification without listing or mutating task lists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    const createdReceipt = JSON.stringify({ formatVersion: 1, managedCalendarId: "managed", taskListId: "created-list" });
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600, flag: "wx" });
    await writeFile(path.join(receiptDirectory, "created.json"), createdReceipt, { mode: 0o600, flag: "wx" });
    const requests: Array<{ url: string; method: string }> = [];

    const result = await reconcileTasksBeforeCalendarVerification({
      accessToken: "temporary",
      managedCalendarId: "managed",
      receiptDirectory,
      fetchFn: async (url, init) => {
        const request = { url: String(url), method: init?.method ?? "GET" };
        requests.push(request);
        if (request.url.includes("/lists/created-list?")) return Response.json({ id: "created-list" });
        if (request.url.includes("/events?")) return Response.json({ accessRole: "owner" });
      if (request.url.includes("calendar/v3/calendars/")) return Response.json({ id: "managed" });
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    assert.deepEqual(result, { managedCalendarId: "managed", taskListId: "created-list" });
    assert.deepEqual(requests.map((request) => request.method), ["GET", "GET", "GET"]);
    assert.match(requests[0]!.url, /tasks\.googleapis\.com\/tasks\/v1\/users\/@me\/lists\/created-list\?/);
    assert.match(requests[1]!.url, /calendar\/v3\/calendars\//);
    assert.match(requests[2]!.url, /\/events\?maxResults=1&fields=accessRole$/);
    assert.ok(requests.every((request) => !request.url.includes("calendarList")));
    assert.equal(await readFile(path.join(receiptDirectory, "created.json"), "utf8"), createdReceipt);
  });

  it("requires the pending receipt binding and fails closed on an unreadable created receipt during reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jarvis-oauth-"));
    temporaryDirectories.push(root);
    const receiptDirectory = path.join(root, "provisioning");
    await mkdir(receiptDirectory, { mode: 0o700 });
    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "other-managed" }), { mode: 0o600, flag: "wx" });
    const neverFetch: typeof fetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      fetchFn: neverFetch,
    }), /binding/i);

    await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify({ formatVersion: 1, managedCalendarId: "managed" }), { mode: 0o600 });
    const createdFile = path.join(receiptDirectory, "created.json");
    await writeFile(createdFile, "existing-created-receipt", { mode: 0o600, flag: "wx" });
    await assert.rejects(resolveManagedTaskList({
      accessToken: "temporary",
      managedCalendarId: "managed",
      reconcileReceiptDirectory: receiptDirectory,
      fetchFn: async (url) => String(url).includes("/lists/reconciled-list?")
        ? Response.json({ id: "reconciled-list" })
        : Response.json({ items: [{ id: "reconciled-list", title: "Jarvis Tasks" }] }),
    }), /readable created receipt/i);
    assert.equal(await readFile(createdFile, "utf8"), "existing-created-receipt");
  });
});
