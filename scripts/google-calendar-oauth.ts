import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;
export const GOOGLE_JARVIS_SCOPES = [...GOOGLE_CALENDAR_SCOPES, "https://www.googleapis.com/auth/tasks"] as const;

interface DesktopClientConfig {
  client_id: string;
  client_secret: string;
}

export function createPkce(entropy: Uint8Array = randomBytes(64)): { verifier: string; challenge: string } {
  const verifier = Buffer.from(entropy).toString("base64url");
  if (verifier.length < 43 || verifier.length > 128) throw new Error("PKCE verifier must contain 43 to 128 characters.");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_JARVIS_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function validateOAuthCallback(url: URL, expectedState: string): string {
  if (url.pathname !== "/oauth/callback") throw new Error("Unexpected OAuth callback path.");
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth callback state mismatch.");
  const oauthError = url.searchParams.get("error");
  if (oauthError) throw new Error(`Google rejected authorization: ${oauthError}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not contain an authorization code.");
  return code;
}

function exactScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const actual = new Set(value.trim().split(/\s+/u).filter(Boolean));
  return actual.size === GOOGLE_JARVIS_SCOPES.length && GOOGLE_JARVIS_SCOPES.every((scope) => actual.has(scope));
}

const OAUTH_TOKEN_EXCHANGE_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

async function formatOAuthTokenExchangeFailure(response: Response): Promise<Error> {
  let oauthError: string | undefined;
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      const error = (payload as Record<string, unknown>).error;
      if (typeof error === "string" && OAUTH_TOKEN_EXCHANGE_ERRORS.has(error)) oauthError = error;
    }
  } catch {
    // The HTTP status is sufficient and does not expose the opaque response body.
  }
  return new Error(`OAuth token exchange failed with status ${response.status}${oauthError ? ` (OAuth error ${oauthError})` : ""}.`);
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchFn?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw await formatOAuthTokenExchangeFailure(response);
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") throw new Error("OAuth token response is incomplete.");
  if (!exactScopes(payload.scope)) throw new Error("OAuth token scopes do not exactly match the approved Calendar/Tasks scopes.");
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
}

export async function createManagedCalendar(accessToken: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const response = await fetchFn("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ summary: "Jarvis Plan", timeZone: "America/Bogota" }),
  });
  if (!response.ok) throw new Error(`Calendar creation failed with status ${response.status}.`);
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.id !== "string" || payload.id.trim().length === 0 || payload.id === "primary") throw new Error("Calendar creation returned an invalid managed calendar ID.");
  return payload.id;
}

function targetId(value: string, kind: "calendar" | "task list"): string {
  if (typeof value !== "string" || !value || /\s|\0/u.test(value) || value.startsWith("@")) throw new Error(`Use an explicit dedicated ${kind} ID.`);
  if (value.toLowerCase() === "primary") throw new Error("The primary calendar is not a managed target.");
  return value;
}

export async function verifyManagedCalendar(accessToken: string, managedCalendarId: string, fetchFn: typeof fetch = fetch): Promise<string> {
  targetId(managedCalendarId, "calendar");
  const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(managedCalendarId)}?fields=id`;
  // calendar.app.created authorizes these reads; do not broaden to full calendar write access.
  // Calendars.get proves the exact target resolves without relying on CalendarList.
  const calendarResponse = await fetchFn(calendarUrl, {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!calendarResponse.ok) throw await formatGoogleReadFailure("Calendar", calendarResponse);
  const calendar = await calendarResponse.json() as Record<string, unknown>;
  if (calendar.id !== managedCalendarId) {
    throw new Error("Managed calendar target must exactly match the resolved calendar.");
  }

  // Events.list exposes only accessRole, never event payloads, to prove the authenticated user owns this target.
  const ownershipResponse = await fetchFn(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(managedCalendarId)}/events?maxResults=1&fields=accessRole`, {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!ownershipResponse.ok) throw await formatGoogleReadFailure("Calendar", ownershipResponse);
  const ownership = await ownershipResponse.json() as Record<string, unknown>;
  if (ownership.accessRole !== "owner") {
    throw new Error("Managed calendar target must be owned by the authenticated user.");
  }
  return managedCalendarId;
}

function allowlistedGoogleField(value: unknown, expression: RegExp): string | undefined {
  return typeof value === "string" && value.length <= 64 && expression.test(value) ? value : undefined;
}

/** Formats Calendar/Tasks read failures without exposing response bodies or credentials. */
export async function formatGoogleReadFailure(service: "Calendar" | "Tasks", response: Response): Promise<Error> {
  let googleStatus: string | undefined;
  let googleReason: string | undefined;
  try {
    const payload = await response.clone().json() as Record<string, unknown>;
    const error = typeof payload.error === "object" && payload.error !== null ? payload.error as Record<string, unknown> : undefined;
    googleStatus = allowlistedGoogleField(error?.status, /^[A-Z_]+$/u);
    const errors = error?.errors;
    if (Array.isArray(errors) && typeof errors[0] === "object" && errors[0] !== null) {
      googleReason = allowlistedGoogleField((errors[0] as Record<string, unknown>).reason, /^[A-Za-z0-9_.-]+$/u);
    }
  } catch {
    // The HTTP status is sufficient and does not expose the opaque response body.
  }
  const fields = [
    googleStatus ? `Google error status ${googleStatus}` : undefined,
    googleReason ? `Google error reason ${googleReason}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return new Error(`${service} read failed with status ${response.status}${fields.length ? ` (${fields.join(", ")})` : ""}.`);
}

async function verifyTaskList(accessToken: string, id: string, fetchFn: typeof fetch): Promise<string> {
  targetId(id, "task list");
  const response = await fetchFn(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(id)}?fields=id`, {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await formatGoogleReadFailure("Tasks", response);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.id !== id) throw new Error("Dedicated task list ID mismatch.");
  return id;
}

interface TaskListProvisioningReceipt {
  formatVersion: 1;
  managedCalendarId: string;
}

async function readPendingTaskListReceipt(receiptDirectory: string, managedCalendarId: string): Promise<TaskListProvisioningReceipt> {
  const pendingFile = path.join(receiptDirectory, "pending.json");
  try {
    if (!(await lstat(receiptDirectory)).isDirectory() || !(await lstat(pendingFile)).isFile()) {
      throw new Error("Missing pending receipt.");
    }
  } catch {
    throw new Error("Task list reconciliation requires an existing durable pending receipt.");
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(await readFile(pendingFile, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Task list reconciliation requires a readable pending receipt.");
  }
  if (receipt.formatVersion !== 1 || receipt.managedCalendarId !== managedCalendarId) {
    throw new Error("Task list provisioning receipt binding mismatch.");
  }
  return { formatVersion: 1, managedCalendarId };
}

async function findJarvisTaskListMatches(accessToken: string, fetchFn: typeof fetch): Promise<string[]> {
  const matches: string[] = [];
  const visitedPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL("https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    // Google TaskLists.list returns paginated items with id and title.
    // https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/list
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await formatGoogleReadFailure("Tasks", response);
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.items)) throw new Error("Task list reconciliation returned an invalid list response.");
    for (const item of payload.items) {
      if (typeof item !== "object" || item === null) continue;
      const taskList = item as Record<string, unknown>;
      if (taskList.title === "Jarvis Tasks") {
        if (typeof taskList.id !== "string") throw new Error("Task list reconciliation returned an invalid matching list ID.");
        matches.push(targetId(taskList.id, "task list"));
      }
    }
    if (payload.nextPageToken === undefined) {
      pageToken = undefined;
    } else if (typeof payload.nextPageToken === "string" && payload.nextPageToken.length > 0 && !visitedPageTokens.has(payload.nextPageToken)) {
      pageToken = payload.nextPageToken;
      visitedPageTokens.add(pageToken);
    } else {
      throw new Error("Task list reconciliation returned an invalid pagination token.");
    }
  } while (pageToken);
  return matches;
}

async function findExactlyOneJarvisTaskList(accessToken: string, fetchFn: typeof fetch): Promise<string> {
  const matches = await findJarvisTaskListMatches(accessToken, fetchFn);
  if (matches.length === 0) throw new Error("Task list reconciliation found zero task lists titled Jarvis Tasks.");
  if (matches.length > 1) throw new Error("Task list reconciliation found multiple task lists titled Jarvis Tasks.");
  return matches[0]!;
}

async function reconcilePendingTaskList(input: {
  accessToken: string;
  managedCalendarId: string;
  receiptDirectory: string;
  fetchFn: typeof fetch;
}): Promise<string> {
  const receipt = await readPendingTaskListReceipt(input.receiptDirectory, input.managedCalendarId);
  const existingTaskListId = await readCreatedTaskListReceipt(input.receiptDirectory, receipt);
  if (existingTaskListId) return verifyTaskList(input.accessToken, existingTaskListId, input.fetchFn);
  const taskListId = await findExactlyOneJarvisTaskList(input.accessToken, input.fetchFn);
  const verifiedTaskListId = await verifyTaskList(input.accessToken, taskListId, input.fetchFn);
  const createdFile = path.join(input.receiptDirectory, "created.json");
  try {
    await writeFile(createdFile, JSON.stringify({ ...receipt, taskListId }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Task list reconciliation will not overwrite an existing created receipt.");
    }
    throw error;
  }
  return verifiedTaskListId;
}

async function readCreatedTaskListReceipt(receiptDirectory: string, pendingReceipt: TaskListProvisioningReceipt): Promise<string | undefined> {
  const createdFile = path.join(receiptDirectory, "created.json");
  try {
    if (!(await lstat(createdFile)).isFile()) throw new Error("Invalid receipt file.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new Error("Task list reconciliation requires a readable created receipt.");
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(await readFile(createdFile, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Task list reconciliation requires a readable created receipt.");
  }
  if (receipt.formatVersion !== pendingReceipt.formatVersion || receipt.managedCalendarId !== pendingReceipt.managedCalendarId || typeof receipt.taskListId !== "string") {
    throw new Error("Task list provisioning receipt binding mismatch.");
  }
  return targetId(receipt.taskListId, "task list");
}

async function verifyCreatedJarvisTaskList(accessToken: string, id: string, fetchFn: typeof fetch): Promise<string> {
  targetId(id, "task list");
  const response = await fetchFn(`https://tasks.googleapis.com/tasks/v1/users/@me/lists/${encodeURIComponent(id)}?fields=id,title`, {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await formatGoogleReadFailure("Tasks", response);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.id !== id || payload.title !== "Jarvis Tasks") throw new Error("Created task list verification did not return the dedicated Jarvis Tasks list.");
  return id;
}

async function recoverZeroMatchPendingTaskList(input: {
  accessToken: string;
  managedCalendarId: string;
  receiptDirectory: string;
  fetchFn: typeof fetch;
}): Promise<string> {
  const receipt = await readPendingTaskListReceipt(input.receiptDirectory, input.managedCalendarId);
  const existingTaskListId = await readCreatedTaskListReceipt(input.receiptDirectory, receipt);
  if (existingTaskListId) return verifyTaskList(input.accessToken, existingTaskListId, input.fetchFn);
  const matches = await findJarvisTaskListMatches(input.accessToken, input.fetchFn);
  if (matches.length !== 0) {
    if (matches.length === 1) throw new Error("Task list recovery found an existing Jarvis Tasks list; reconcile it without zero-match creation.");
    throw new Error("Task list recovery found multiple task lists titled Jarvis Tasks.");
  }
  try {
    // A bounded pending receipt and a complete zero-match readback are required before this one non-idempotent POST.
    const response = await input.fetchFn("https://tasks.googleapis.com/tasks/v1/users/@me/lists", {
      method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Jarvis Tasks" }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Task list recovery creation was not acknowledged.");
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.id !== "string") throw new Error("Task list recovery creation returned no ID.");
    const taskListId = targetId(payload.id, "task list");
    await verifyCreatedJarvisTaskList(input.accessToken, taskListId, input.fetchFn);
    await writeFile(path.join(input.receiptDirectory, "created.json"), JSON.stringify({ ...receipt, taskListId }), { mode: 0o600, flag: "wx" });
    return taskListId;
  } catch {
    throw new Error("Task list zero-match recovery has an unknown outcome. Reconcile its ID before retrying; do not remove the receipt.");
  }
}

export async function resolveManagedTaskList(input: {
  accessToken: string;
  managedCalendarId: string;
  taskListId?: string;
  receiptDirectory?: string;
  reconcileReceiptDirectory?: string;
  createWhenNoExactTitleMatch?: boolean;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const fetchFn = input.fetchFn ?? fetch;
  targetId(input.managedCalendarId, "calendar");
  const modes = [input.taskListId, input.receiptDirectory, input.reconcileReceiptDirectory].filter(Boolean);
  if (modes.length !== 1) throw new Error("Choose exactly one task list mode: existing list reuse, explicit list creation, or pending receipt reconciliation.");
  if (input.createWhenNoExactTitleMatch && !input.reconcileReceiptDirectory) {
    throw new Error("Zero-match task list creation requires pending receipt reconciliation.");
  }
  if (input.taskListId) return verifyTaskList(input.accessToken, input.taskListId, fetchFn);
  if (input.reconcileReceiptDirectory) {
    if (input.createWhenNoExactTitleMatch) {
      return recoverZeroMatchPendingTaskList({
        accessToken: input.accessToken,
        managedCalendarId: input.managedCalendarId,
        receiptDirectory: input.reconcileReceiptDirectory,
        fetchFn,
      });
    }
    return reconcilePendingTaskList({
      accessToken: input.accessToken,
      managedCalendarId: input.managedCalendarId,
      receiptDirectory: input.reconcileReceiptDirectory,
      fetchFn,
    });
  }
  const receiptDirectory = input.receiptDirectory;
  if (!receiptDirectory) throw new Error("Task list creation requires a private receipt directory.");
  const createdFile = path.join(receiptDirectory, "created.json");
  try { await mkdir(receiptDirectory, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (!(await lstat(receiptDirectory)).isDirectory()) throw new Error("Provisioning receipt must be a private directory, not a link.");
    let receipt: Record<string, unknown>;
    try {
      if (!(await lstat(createdFile)).isFile()) throw new Error("Invalid receipt file.");
      receipt = JSON.parse(await readFile(createdFile, "utf8")) as Record<string, unknown>;
    } catch { throw new Error("Task list creation has an unknown outcome. Reconcile its ID before retrying; do not remove the receipt."); }
    if (receipt.formatVersion !== 1 || receipt.managedCalendarId !== input.managedCalendarId || typeof receipt.taskListId !== "string") {
      throw new Error("Task list provisioning receipt binding mismatch.");
    }
    return verifyTaskList(input.accessToken, receipt.taskListId, fetchFn);
  }
  const receipt = { formatVersion: 1, managedCalendarId: input.managedCalendarId };
  // Persist intent before the non-idempotent POST. No token or authorization URL is stored here.
  await writeFile(path.join(receiptDirectory, "pending.json"), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  try {
    // https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/insert
    const response = await fetchFn("https://tasks.googleapis.com/tasks/v1/users/@me/lists", {
      method: "POST", headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Jarvis Tasks" }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Task list creation was not acknowledged.");
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.id !== "string") throw new Error("No task list ID returned.");
    const taskListId = targetId(payload.id, "task list");
    await writeFile(createdFile, JSON.stringify({ ...receipt, taskListId }), { mode: 0o600, flag: "wx" });
    return taskListId;
  } catch {
    throw new Error("Task list creation has an unknown outcome. Reconcile its ID before retrying; do not remove the receipt.");
  }
}

/**
 * The sole recovery route that reconciles an already-pending task receipt before a CalendarList read.
 * It only performs Task-list GETs until the task receipt is durably finalized.
 */
export async function reconcileTasksBeforeCalendarVerification(input: {
  accessToken: string;
  managedCalendarId: string;
  receiptDirectory: string;
  createWhenNoExactTitleMatch?: boolean;
  fetchFn?: typeof fetch;
}): Promise<{ managedCalendarId: string; taskListId: string }> {
  const fetchFn = input.fetchFn ?? fetch;
  targetId(input.managedCalendarId, "calendar");
  const taskListId = await resolveManagedTaskList({
    accessToken: input.accessToken,
    managedCalendarId: input.managedCalendarId,
    reconcileReceiptDirectory: input.receiptDirectory,
    ...(input.createWhenNoExactTitleMatch ? { createWhenNoExactTitleMatch: true } : {}),
    fetchFn,
  });
  await verifyManagedCalendar(input.accessToken, input.managedCalendarId, fetchFn);
  return { managedCalendarId: input.managedCalendarId, taskListId };
}

function safeEnvValue(value: string, name: string): string {
  if (!value || /[\r\n\0]/u.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

export async function writeRailwayCalendarEnv(outputPath: string, input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  managedCalendarId: string;
  taskListId: string;
}): Promise<{ outputPath: string; managedCalendarId: string; taskListId: string }> {
  targetId(input.managedCalendarId, "calendar");
  targetId(input.taskListId, "task list");
  const lines = [
    "JARVIS_CALENDAR_ENABLED=false",
    `GOOGLE_CLIENT_ID=${safeEnvValue(input.clientId, "clientId")}`,
    `GOOGLE_CLIENT_SECRET=${safeEnvValue(input.clientSecret, "clientSecret")}`,
    `GOOGLE_REFRESH_TOKEN=${safeEnvValue(input.refreshToken, "refreshToken")}`,
    "GOOGLE_PRIMARY_CALENDAR_ID=primary",
    `GOOGLE_MANAGED_CALENDAR_ID=${safeEnvValue(input.managedCalendarId, "managedCalendarId")}`,
    "JARVIS_TASKS_ENABLED=false",
    `GOOGLE_TASKS_LIST_ID=${safeEnvValue(input.taskListId, "taskListId")}`,
  ];
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { outputPath, managedCalendarId: input.managedCalendarId, taskListId: input.taskListId };
}

/**
 * Recovers a task-list receipt and writes a disabled-runtime artifact without a Calendar API read.
 * This is deliberately limited to the private pending-receipt recovery path after Calendar verification failed.
 */
export async function recoverTasksAndWriteDeferredCalendarEnv(input: {
  accessToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  managedCalendarId: string;
  receiptDirectory: string;
  outputPath: string;
  createWhenNoExactTitleMatch?: boolean;
  fetchFn?: typeof fetch;
}): Promise<{ outputPath: string; managedCalendarId: string; taskListId: string }> {
  targetId(input.managedCalendarId, "calendar");
  const taskListId = await resolveManagedTaskList({
    accessToken: input.accessToken,
    managedCalendarId: input.managedCalendarId,
    reconcileReceiptDirectory: input.receiptDirectory,
    ...(input.createWhenNoExactTitleMatch ? { createWhenNoExactTitleMatch: true } : {}),
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
  });
  return writeRailwayCalendarEnv(input.outputPath, {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: input.refreshToken,
    managedCalendarId: input.managedCalendarId,
    taskListId,
  });
}

async function loadDesktopClient(filePath: string): Promise<DesktopClientConfig> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  if ("web" in parsed || typeof parsed.installed !== "object" || parsed.installed === null) throw new Error("Use a Google OAuth Desktop app client, not a Web client.");
  const installed = parsed.installed as Record<string, unknown>;
  if (typeof installed.client_id !== "string" || typeof installed.client_secret !== "string") throw new Error("Desktop OAuth client JSON is incomplete.");
  return { client_id: installed.client_id, client_secret: installed.client_secret };
}

async function waitForCode(state: string): Promise<{ codePromise: Promise<string>; redirectUri: string; close: () => Promise<void> }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const code = validateOAuthCallback(url, state);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Jarvis Calendar authorization received. You can close this tab.");
      resolveCode(code);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization could not be accepted.");
      rejectCode(error instanceof Error ? error : new Error("Invalid OAuth callback."));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback OAuth server did not bind to a TCP port.");
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    close: async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    codePromise,
  };
}

export interface OAuthCliOptions {
  clientPath: string;
  outputPath: string;
  managedCalendarId?: string;
  createManagedCalendar: boolean;
  listId?: string;
  createList: boolean;
  reconcileTasksReceiptDirectory?: string;
  createWhenNoExactTitleMatch?: boolean;
  deferCalendarVerification?: boolean;
}

export function parseOAuthCliOptions(args: string[]): OAuthCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--client", "--output", "--managed-calendar-id", "--tasks-list-id", "--reconcile-tasks-receipt"]);
  const flagOptions = new Set(["--create-managed-calendar", "--create-tasks-list", "--create-tasks-list-if-none", "--defer-calendar-verification"]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || values.has(argument)) throw new Error(`Invalid ${argument} option.`);
      values.set(argument, value);
      index += 1;
    } else if (flagOptions.has(argument)) {
      if (flags.has(argument)) throw new Error(`Duplicate ${argument} option.`);
      flags.add(argument);
    } else {
      throw new Error(`Unknown OAuth option: ${argument}.`);
    }
  }

  const clientPath = values.get("--client");
  const managedCalendarId = values.get("--managed-calendar-id");
  const createManagedCalendar = flags.has("--create-managed-calendar");
  const listId = values.get("--tasks-list-id");
  const createList = flags.has("--create-tasks-list");
  const reconcileTasksReceiptDirectory = values.get("--reconcile-tasks-receipt");
  const createWhenNoExactTitleMatch = flags.has("--create-tasks-list-if-none");
  const deferCalendarVerification = flags.has("--defer-calendar-verification");
  if (Boolean(managedCalendarId) === createManagedCalendar) {
    throw new Error("Choose exactly one managed calendar mode: --managed-calendar-id or --create-managed-calendar.");
  }
  if (reconcileTasksReceiptDirectory && createManagedCalendar) {
    throw new Error("Task list reconciliation requires --managed-calendar-id so it can bind to a verified managed calendar.");
  }
  if (createWhenNoExactTitleMatch && !reconcileTasksReceiptDirectory) {
    throw new Error("--create-tasks-list-if-none requires --reconcile-tasks-receipt <private-receipt-directory>.");
  }
  if (deferCalendarVerification && !reconcileTasksReceiptDirectory) {
    throw new Error("--defer-calendar-verification is permitted only for private task receipt reconciliation.");
  }
  if (!clientPath || [listId, createList ? "create" : undefined, reconcileTasksReceiptDirectory].filter(Boolean).length !== 1) {
    throw new Error("Choose exactly one task list mode. Usage: npm run calendar:oauth -- --client <desktop-client.json> (--managed-calendar-id <existing-id> | --create-managed-calendar) (--tasks-list-id <existing-id> | --create-tasks-list | --reconcile-tasks-receipt <private-receipt-directory> [--create-tasks-list-if-none]) [--output .env.jarvis-calendar]");
  }
  return {
    clientPath,
    outputPath: values.get("--output") ?? ".env.jarvis-calendar",
    ...(managedCalendarId ? { managedCalendarId } : {}),
    createManagedCalendar,
    ...(listId ? { listId } : {}),
    createList,
    ...(reconcileTasksReceiptDirectory ? { reconcileTasksReceiptDirectory } : {}),
    ...(createWhenNoExactTitleMatch ? { createWhenNoExactTitleMatch } : {}),
    ...(deferCalendarVerification ? { deferCalendarVerification } : {}),
  };
}

async function run(): Promise<void> {
  const options = parseOAuthCliOptions(process.argv.slice(2));
  if (options.managedCalendarId) targetId(options.managedCalendarId, "calendar");
  if (options.listId) targetId(options.listId, "task list");
  const outputPath = path.resolve(options.outputPath);
  const client = await loadDesktopClient(path.resolve(options.clientPath));
  const state = randomBytes(32).toString("base64url");
  const pkce = createPkce();
  const pending = await waitForCode(state);
  const authorizationUrl = buildAuthorizationUrl({ clientId: client.client_id, redirectUri: pending.redirectUri, state, challenge: pkce.challenge });
  process.stdout.write(`Open this Google authorization URL in your browser:\n${authorizationUrl}\n`);
  try {
    const code = await pending.codePromise;
    const tokens = await exchangeAuthorizationCode({ clientId: client.client_id, clientSecret: client.client_secret, redirectUri: pending.redirectUri, code, verifier: pkce.verifier });
    if (options.deferCalendarVerification) {
      const result = await recoverTasksAndWriteDeferredCalendarEnv({
        accessToken: tokens.accessToken,
        clientId: client.client_id,
        clientSecret: client.client_secret,
        refreshToken: tokens.refreshToken,
        managedCalendarId: options.managedCalendarId!,
        receiptDirectory: path.resolve(options.reconcileTasksReceiptDirectory!),
        outputPath,
        ...(options.createWhenNoExactTitleMatch ? { createWhenNoExactTitleMatch: true } : {}),
      });
      process.stdout.write(`Google authorization prepared with Calendar verification deferred. Restricted Railway variable artifact: ${result.outputPath}\nManaged calendar: ${result.managedCalendarId}\nDedicated task list: ${result.taskListId}\nCalendar and Tasks runtimes remain disabled until Calendar verification and the sync adapter are verified.\n`);
      return;
    }
    const recovery = options.reconcileTasksReceiptDirectory
      ? await reconcileTasksBeforeCalendarVerification({
        accessToken: tokens.accessToken,
        managedCalendarId: options.managedCalendarId!,
        receiptDirectory: path.resolve(options.reconcileTasksReceiptDirectory),
        ...(options.createWhenNoExactTitleMatch ? { createWhenNoExactTitleMatch: true } : {}),
      })
      : undefined;
    const managedCalendarId = recovery?.managedCalendarId ?? (options.createManagedCalendar
      ? await createManagedCalendar(tokens.accessToken)
      : await verifyManagedCalendar(tokens.accessToken, options.managedCalendarId!));
    const taskListId = recovery?.taskListId ?? await resolveManagedTaskList({ accessToken: tokens.accessToken, managedCalendarId,
      ...(options.listId
        ? { taskListId: options.listId }
        : { receiptDirectory: `${outputPath}.provisioning` }) });
    const result = await writeRailwayCalendarEnv(outputPath, { clientId: client.client_id, clientSecret: client.client_secret, refreshToken: tokens.refreshToken, managedCalendarId, taskListId });
    process.stdout.write(`Google authorization prepared. Restricted Railway variable artifact: ${result.outputPath}\nManaged calendar: ${result.managedCalendarId}\nDedicated task list: ${result.taskListId}\nTasks runtime remains disabled until the sync adapter is verified.\n`);
  } finally {
    await pending.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error: unknown) => {
    process.stderr.write(`CALENDAR_BOOTSTRAP_FAILED ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
