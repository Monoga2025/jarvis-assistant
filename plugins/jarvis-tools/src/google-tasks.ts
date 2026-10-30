import type { GoogleTokenProvider } from "./calendar.js";
import { canonicalDate, canonicalInstant } from "./date-time.js";
import type { TaskService, GoogleTaskClaim, TaskSyncIntent } from "./task-service.js";

export interface GoogleTask extends Record<string, unknown> {
  kind: "tasks#task"; id: string; etag: string; updated: string;
  title?: string; notes?: string; status?: "needsAction" | "completed";
  due?: string; completed?: string; deleted?: boolean;
}
type FailureCode = "precondition" | "auth" | "access" | "not_found" | "rate_limit" | "rejected" | "unavailable" | "network" | "invalid_response" | "limit";
export class GoogleTasksError extends Error {
  constructor(public readonly code: FailureCode) { super(`Google Tasks request failed: ${code}.`); this.name = "GoogleTasksError"; }
}
const maxResponseBytes = 1_048_576, maxScanBytes = 8_388_608, maxPages = 20;
const fields = "kind,id,etag,updated,title,notes,status,due,completed,deleted,parent,assignmentInfo";
function id(value: string, field: string): string {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error(`An exact Google Tasks ${field} ID is required.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleTasksError("invalid_response");
  return value as Record<string, unknown>;
}
function providerInstant(value: unknown): string {
  // RFC3339 fractions are not restricted to JavaScript milliseconds. Validate/normalize whole seconds
  // separately, preserving up to 30 fractional digits as text (a resource bound, not precision loss).
  // Source: https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6
  if (typeof value !== "string" || value.length > 64) throw new GoogleTasksError("invalid_response");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,30}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) throw new GoogleTasksError("invalid_response");
  const whole = canonicalInstant(`${match[1]!.toUpperCase()}${match[3]!.toUpperCase()}`, "remote timestamp");
  const fraction = (match[2] ?? "").replace(/0+$/, "").padEnd(3, "0");
  return `${whole.slice(0, -5)}.${fraction}Z`;
}
function parseTask(value: unknown): GoogleTask {
  const task = object(value);
  if (task.kind !== "tasks#task" || typeof task.id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(task.id) ||
    typeof task.etag !== "string" || !task.etag || task.etag.length > 1024 || typeof task.updated !== "string") throw new GoogleTasksError("invalid_response");
  for (const [key, limit] of [["title", 1024], ["notes", 8192]] as const) {
    if (task[key] !== undefined && (typeof task[key] !== "string" || task[key].length > limit)) throw new GoogleTasksError("invalid_response");
  }
  if (task.deleted !== undefined && typeof task.deleted !== "boolean") throw new GoogleTasksError("invalid_response");
  if (task.status !== undefined && !["needsAction", "completed"].includes(String(task.status))) throw new GoogleTasksError("invalid_response");
  try {
    task.updated = providerInstant(task.updated);
    if (task.due !== undefined) {
      const instant = providerInstant(task.due);
      task.due = `${canonicalDate(instant.slice(0, 10), "remote planned day")}T00:00:00.000Z`;
    }
    if (task.completed !== undefined) task.completed = providerInstant(task.completed);
  } catch { throw new GoogleTasksError("invalid_response"); }
  return Object.fromEntries(Object.entries(task).filter(([key]) => fields.split(",").includes(key))
    .map(([key, value]) => [key, key === "assignmentInfo" && value ? { present: true } : key === "parent" && value ? "present" : value])) as GoogleTask;
}

/** Fixed host and dedicated list; no caller URL, list discovery, retries, or DELETE surface.
 * Sources: https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert
 * https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list
 * https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/get
 */
export class GoogleTasksClient {
  readonly listId: string;
  readonly conditionalPatchVerified = false;
  constructor(listId: string, private readonly tokens: GoogleTokenProvider, private readonly fetchFn: typeof fetch = fetch) {
    this.listId = id(listId, "list");
  }
  private async request(method: "GET" | "POST", suffix: string, query: URLSearchParams, body?: Record<string, unknown>, etag?: string): Promise<{ value: unknown; bytes: number }> {
    let accessToken: string;
    try { accessToken = await this.tokens.getAccessToken(); if (!accessToken) throw new Error(); }
    catch { throw new GoogleTasksError("auth"); }
    const url = new URL(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(this.listId)}/tasks${suffix}`);
    url.search = query.toString();
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 48_000) throw new GoogleTasksError("limit");
    let response: Response;
    try {
      response = await this.fetchFn(url, { method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) },
        ...(serialized === undefined ? {} : { body: serialized }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch { throw new GoogleTasksError("network"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GoogleTasksError(response.status === 401 ? "auth" : response.status === 403 ? "access" : response.status === 404 ? "not_found" :
        response.status === 429 ? "rate_limit" : response.status === 412 ? "precondition" : response.status >= 500 ? "unavailable" : "rejected");
    }
    if (Number(response.headers.get("content-length")) > maxResponseBytes) { await response.body?.cancel(); throw new GoogleTasksError("limit"); }
    const reader = response.body?.getReader();
    if (!reader) throw new GoogleTasksError("invalid_response");
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxResponseBytes) { await reader.cancel(); throw new GoogleTasksError("limit"); }
        chunks.push(item.value);
      }
      return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes };
    } catch (error) { throw error instanceof GoogleTasksError ? error : new GoogleTasksError("invalid_response"); }
    finally { reader.releaseLock(); }
  }
  async insert(body: Record<string, unknown>): Promise<GoogleTask> {
    return parseTask((await this.request("POST", "", new URLSearchParams({ fields }), body)).value);
  }
  async get(taskId: string): Promise<GoogleTask> {
    const task = parseTask((await this.request("GET", `/${encodeURIComponent(id(taskId, "task"))}`, new URLSearchParams({ fields }))).value);
    if (task.id !== taskId) throw new GoogleTasksError("invalid_response");
    return task;
  }
  /** Minimal non-mutating startup readiness probe. The response is never logged. */
  async probe(): Promise<void> {
    const response = await this.request("GET", "", new URLSearchParams({ maxResults: "1", fields: "items(id),nextPageToken" }));
    const page = object(response.value);
    if (page.items !== undefined && (!Array.isArray(page.items) || page.items.length > 1)) throw new GoogleTasksError("invalid_response");
  }
  async scan(): Promise<{ tasks: GoogleTask[]; pages: number }> {
    const tasks: GoogleTask[] = [], tokens = new Set<string>(); let pageToken: string | undefined, bytes = 0;
    // A recovery scan must include cleared/completed and deleted records, not only visible tasks.
    // Source: https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list
    for (let pages = 1; pages <= maxPages; pages++) {
      const query = new URLSearchParams({ maxResults: "100", showCompleted: "true", showHidden: "true", showDeleted: "true", showAssigned: "true", fields: `nextPageToken,items(${fields})` });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request("GET", "", query); bytes += response.bytes;
      if (bytes > maxScanBytes) throw new GoogleTasksError("limit");
      const page = object(response.value);
      if (page.items !== undefined && (!Array.isArray(page.items) || page.items.length > 100)) throw new GoogleTasksError("invalid_response");
      tasks.push(...((page.items ?? []) as unknown[]).map(parseTask));
      if (page.nextPageToken === undefined) return { tasks, pages };
      if (typeof page.nextPageToken !== "string" || !page.nextPageToken || page.nextPageToken.length > 2048 || tokens.has(page.nextPageToken)) throw new GoogleTasksError("limit");
      pageToken = page.nextPageToken; tokens.add(pageToken);
    }
    throw new GoogleTasksError("limit");
  }
}

function projectionBody(task: TaskSyncIntent["payload"], marker: string): Record<string, unknown> {
  // due is a planned calendar day, never a deadline or scheduled time.
  // Source: https://developers.google.com/workspace/tasks/reference/rest/v1/tasks
  const details = `Subject: ${task.subject}\nDescription: ${task.description}\nCompletion criteria: ${task.completionCriteria}\nDeadline: ${JSON.stringify(task.deadline)}\nSource: ${task.sourceSystem}/${task.legacyId}`;
  const noteLimit = 8192 - marker.length - 2;
  const truncation = "\n[Details truncated; the full source remains in Jarvis.]";
  const notes = `${details.length <= noteLimit ? details : details.slice(0, noteLimit - truncation.length) + truncation}\n\n${marker}`;
  return { title: task.title, notes, status: task.status === "completed" ? "completed" : "needsAction",
    ...(task.plannedDate ? { due: `${task.plannedDate}T00:00:00.000Z` } : {}),
    ...(task.completedAt ? { completed: task.completedAt } : {}) };
}
function matchesRequest(claim: GoogleTaskClaim, remote: GoogleTask): boolean {
  const request = claim.projection.request;
  return !!request && remote.deleted !== true && !remote.parent && !remote.assignmentInfo &&
    Object.entries(request).every(([key, value]) => remote[key] === value) && (request.due !== undefined || remote.due === undefined);
}
export type DispatchResult = "disabled" | "idle" | "synced" | "unknown" | "conflict" | "detached" | "write_disabled";

/** Trusted application entry point, not an agent tool. Runtime scheduling is intentionally not installed yet.
 * This slice inserts only; later mapped revisions stay queued until safe remote-edit reconciliation exists.
 */
export class GoogleTasksDispatcher {
  private readonly enabled: boolean;
  constructor(private readonly store: TaskService, private readonly client: GoogleTasksClient,
    options: { enabled?: boolean; log?: (line: string) => void } = {}) {
    this.enabled = options.enabled === true;
    this.log = options.log ?? (() => {});
  }
  private readonly log: (line: string) => void;
  private report(error: unknown): void {
    // Never log provider bodies, tokens, task notes, owner IDs, or raw exception messages.
    this.log(`GOOGLE_TASKS_FAILURE code=${error instanceof GoogleTasksError ? error.code : "local_or_unexpected"}`);
  }
  async dispatchOne(): Promise<DispatchResult> {
    if (!this.enabled) return "disabled";
    const claim = this.store.claimGoogleTaskInsert(this.client.listId);
    if (!claim) return "idle";
    return this.dispatchClaim(claim);
  }
  private async dispatchClaim(claim: GoogleTaskClaim): Promise<DispatchResult> {
    try {
      claim = this.store.prepareGoogleTaskRequest(claim, projectionBody(claim.intent.payload, claim.projection.marker));
      const remote = await this.client.insert(claim.projection.request!);
      if (!matchesRequest(claim, remote)) throw new GoogleTasksError("invalid_response");
      this.store.settleGoogleTaskInsert(claim, { outcome: "synced", requestHash: claim.projection.requestHash,
        remote, proof: { kind: "insert_ack", pages: 0, matches: 1 } });
      return "synced";
    } catch (error) {
      this.report(error);
      this.store.settleGoogleTaskInsert(claim, { outcome: "unknown", requestHash: claim.projection.requestHash });
      return "unknown";
    }
  }
  async reconcileUnknown(taskId: number): Promise<DispatchResult> {
    if (!this.enabled) return "disabled";
    const claim = this.store.getGoogleTaskClaim(taskId);
    if (!claim) return "idle";
    if (claim.projection.listId !== this.client.listId) throw new Error("Google Tasks list binding mismatch.");
    if (claim.projection.state === "synced" || claim.projection.state === "conflict") return claim.projection.state;
    // Interrupted claims must first be quarantined by the stopped-dispatcher recovery procedure.
    if (claim.intent.state !== "unknown") return "unknown";
    try {
      if (!claim.projection.request) {
        return await this.dispatchClaim(this.store.resumeUnpreparedGoogleTaskInsert(claim));
      }
      const scan = await this.client.scan();
      // Editable notes provide correlation, not permission. Require the locally bound owner/list/intent,
      // one exact marker line, full desired content, and stable exact-ID readback before adopting.
      const matches = scan.tasks.filter((task) => task.notes?.split(/\r?\n/).includes(claim.projection.marker));
      if (!matches.length) return "unknown"; // Absence is not proof that the POST never committed.
      if (matches.length !== 1 || !matchesRequest(claim, matches[0]!)) {
        this.store.settleGoogleTaskInsert(claim, { outcome: "conflict", requestHash: claim.projection.requestHash }); return "conflict";
      }
      const remote = await this.client.get(matches[0]!.id);
      if (remote.etag !== matches[0]!.etag || remote.updated !== matches[0]!.updated || !matchesRequest(claim, remote)) {
        this.store.settleGoogleTaskInsert(claim, { outcome: "conflict", requestHash: claim.projection.requestHash }); return "conflict";
      }
      this.store.settleGoogleTaskInsert(claim, { outcome: "synced", requestHash: claim.projection.requestHash, remote,
        proof: { kind: "complete_scan", pages: scan.pages, matches: 1 } });
      return "synced";
    } catch (error) { this.report(error); return "unknown"; }
  }
}
