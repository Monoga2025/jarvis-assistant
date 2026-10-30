import { readFile } from "node:fs/promises";
import type { GoogleTokenProvider } from "./calendar.js";
import { GoogleOAuthTokenProvider } from "./calendar.js";
import { GoogleTasksClient, GoogleTasksDispatcher, type DispatchResult } from "./google-tasks.js";
import type { TaskService } from "./task-service.js";

export interface GoogleTasksCanaryConfig {
  enabled: false;
}
export interface EnabledGoogleTasksCanaryConfig {
  enabled: true;
  listId: string;
  pollSeconds: number;
  credentialFiles: { clientId: string; clientSecret: string; refreshToken: string };
}
export type ParsedGoogleTasksCanaryConfig = GoogleTasksCanaryConfig | EnabledGoogleTasksCanaryConfig;

type Environment = Record<string, string | undefined>;
const listIdPattern = /^[A-Za-z0-9_-]{1,512}$/;

function requireLiteral(value: string | undefined, name: string, expected: string): void {
  if (value !== expected) throw new Error(`${name} must be literal ${expected}.`);
}
function requiredFile(value: string | undefined, name: string): string {
  if (!value || !value.startsWith("/") || /[\r\n\0]/.test(value)) throw new Error(`${name} must be an absolute credential file.`);
  return value;
}

/** Parses only literals. Call this before opening SQLite, reading credentials, or creating a network client. */
export function parseGoogleTasksCanaryConfig(env: Environment): ParsedGoogleTasksCanaryConfig {
  const enabled = env.JARVIS_GOOGLE_TASKS_ENABLED ?? "false";
  if (enabled === "false") return { enabled: false };
  requireLiteral(enabled, "JARVIS_GOOGLE_TASKS_ENABLED", "true");
  requireLiteral(env.JARVIS_CALENDAR_ENABLED, "JARVIS_CALENDAR_ENABLED", "true");
  const listId = env.GOOGLE_TASKS_LIST_ID;
  if (!listId || !listIdPattern.test(listId)) throw new Error("GOOGLE_TASKS_LIST_ID is invalid.");
  requireLiteral(env.JARVIS_GOOGLE_TASKS_CANARY_MODE, "JARVIS_GOOGLE_TASKS_CANARY_MODE", "single_insert");
  const rawPoll = env.JARVIS_GOOGLE_TASKS_POLL_SECONDS;
  if (!rawPoll || !/^[1-9][0-9]*$/.test(rawPoll)) throw new Error("JARVIS_GOOGLE_TASKS_POLL_SECONDS is invalid.");
  const pollSeconds = Number(rawPoll);
  if (!Number.isSafeInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new Error("JARVIS_GOOGLE_TASKS_POLL_SECONDS must be between 5 and 3600.");
  return { enabled: true, listId, pollSeconds, credentialFiles: {
    clientId: requiredFile(env.GOOGLE_CLIENT_ID_FILE, "GOOGLE_CLIENT_ID_FILE"),
    clientSecret: requiredFile(env.GOOGLE_CLIENT_SECRET_FILE, "GOOGLE_CLIENT_SECRET_FILE"),
    refreshToken: requiredFile(env.GOOGLE_REFRESH_TOKEN_FILE, "GOOGLE_REFRESH_TOKEN_FILE"),
  } };
}

export function createGoogleTasksTokenProvider(config: EnabledGoogleTasksCanaryConfig): GoogleTokenProvider {
  return new GoogleOAuthTokenProvider(async () => ({
    clientId: (await readFile(config.credentialFiles.clientId, "utf8")).trim(),
    clientSecret: (await readFile(config.credentialFiles.clientSecret, "utf8")).trim(),
    refreshToken: (await readFile(config.credentialFiles.refreshToken, "utf8")).trim(),
  }));
}

/** A deliberately one-way worker: one mutation-capable action for its entire process lifetime. */
export class GoogleTasksCanaryWorker {
  private mutationBudget = 1;
  constructor(private readonly store: TaskService, private readonly dispatcher: GoogleTasksDispatcher, private readonly listId: string,
    private readonly lease: string, private readonly log: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}

  async runCycle(): Promise<DispatchResult | "budget_exhausted"> {
    this.store.renewGoogleTasksCanaryLease(this.lease);
    if (this.mutationBudget === 0) return "budget_exhausted";
    // Recovery is intentionally preferred and consumes the only budget even when its scan finds no provider mutation.
    const recovery = this.store.listSyncIntents().find((intent) => intent.state === "unknown" && this.store.getGoogleTaskClaim(intent.taskId)?.projection.listId === this.listId);
    if (recovery) {
      this.mutationBudget = 0;
      const result = await this.dispatcher.reconcileUnknown(recovery.taskId);
      this.log(`GOOGLE_TASKS_CANARY_CYCLE result=${result} budget_remaining=0`);
      return result;
    }
    // Do not spend the budget while idle. A queued canonical outbox record is the sole insertion candidate.
    if (!this.store.listSyncIntents().some((intent) => intent.state === "queued")) return "idle";
    this.mutationBudget = 0;
    const result = await this.dispatcher.dispatchOne();
    this.log(`GOOGLE_TASKS_CANARY_CYCLE result=${result} budget_remaining=0`);
    return result;
  }
}

export function createGoogleTasksCanaryDispatcher(store: TaskService, config: EnabledGoogleTasksCanaryConfig, log?: (line: string) => void): GoogleTasksDispatcher {
  const client = new GoogleTasksClient(config.listId, createGoogleTasksTokenProvider(config));
  return new GoogleTasksDispatcher(store, client, log ? { enabled: true, log } : { enabled: true });
}
