import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSON5 from "json5";

const root = path.resolve(import.meta.dirname, "..");
const text = (file: string) => readFile(path.join(root, file), "utf8");

describe("Railway production deployment", () => {
  it("builds the pinned OpenClaw release on the supported Node 24 line", async () => {
    const dockerfile = await text("Dockerfile");
    assert.match(dockerfile, /^FROM node:24\.15\.0-bookworm-slim AS build/m);
    assert.match(dockerfile, /RUN npm ci/);
    assert.doesNotMatch(dockerfile, /npm ci --ignore-scripts/);
    assert.match(dockerfile, /npm run build/);
    assert.match(dockerfile, /openclaw config validate/);
    assert.match(dockerfile, /npm prune --omit=dev/);
    const entrypoint = await text("deploy/railway-entrypoint.sh");
    assert.match(entrypoint, /gosu node "\$@" &/);
    assert.doesNotMatch(dockerfile, /podman|tailscale|funnel/i);
  });

  it("declares a continuously running Docker worker with an always restart policy", async () => {
    const config = JSON.parse(await text("railway.json")) as {
      build?: { builder?: string; dockerfilePath?: string };
      deploy?: Record<string, unknown>;
    };
    assert.equal(config.build?.builder, "DOCKERFILE");
    assert.equal(config.build?.dockerfilePath, "Dockerfile");
    assert.equal(config.deploy?.restartPolicyType, "ALWAYS");
    assert.equal(config.deploy?.cronSchedule, undefined);
    assert.equal(config.deploy?.healthcheckPath, undefined);
  });

  it("initializes persistent state fail-closed without logging or committing secrets", async () => {
    const entrypoint = await text("deploy/railway-entrypoint.sh");
    for (const variable of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_ID",
      "OPENAI_API_KEY",
      "JARVIS_DB_PATH",
      "JARVIS_TIMEZONE",
      "REMINDER_POLL_SECONDS",
    ]) assert.match(entrypoint, new RegExp(variable));
    assert.match(entrypoint, /TELEGRAM_OWNER_ID=.*TELEGRAM_ALLOWED_USER_ID/);
    assert.match(entrypoint, /JARVIS_ROOT=\/data\/jarvis-v1/);
    assert.match(entrypoint, /OPENCLAW_STATE_DIR=.*JARVIS_ROOT/);
    assert.match(entrypoint, /OPENCLAW_WORKSPACE_DIR=.*JARVIS_ROOT.*workspace/);
    assert.match(entrypoint, /umask 077/);
    assert.match(entrypoint, /chmod 0600/);
    assert.doesNotMatch(entrypoint, /write_secret OPENAI_API_KEY/);
    assert.match(entrypoint, /unset TELEGRAM_BOT_TOKEN/);
    assert.match(entrypoint, /unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN/);
    assert.match(entrypoint, /if \[\[ ! -e "\$JARVIS_ROOT\/\.jarvis-initialized" \]\]/);
    for (const policy of ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md"]) {
      assert.match(entrypoint, new RegExp(`install[^\\n]+/app/workspace/${policy.replace(".", "\\.")}[^\\n]+\\$JARVIS_ROOT/workspace/${policy.replace(".", "\\.")}`));
    }
    assert.match(entrypoint, /workspace\/skills\/jarvis-os\/SKILL\.md/);
    assert.doesNotMatch(entrypoint, /install[^\n]+MEMORY\.md/);
    assert.doesNotMatch(entrypoint, /chown -R node:node \/data(?:\s|$)/m);
    assert.doesNotMatch(entrypoint, /set -x|printenv|\benv\b\s*$/m);
    assert.match(entrypoint, /JARVIS_CALENDAR_ENABLED/);
    assert.match(entrypoint, /GOOGLE_CALENDAR_DISABLED_STALE_FILES_REMOVED/);
    assert.match(entrypoint, /GOOGLE_CALENDAR_CREDENTIALS_INCOMPLETE/);
    assert.match(entrypoint, /calendar-readiness\.js/);
    assert.match(entrypoint, /legacy-seed\.js/);
    assert.match(entrypoint, /reminder-worker\.js/);
    assert.match(entrypoint, /google-tasks-worker-main\.js/);
    assert.match(entrypoint, /GOOGLE_TASKS_REQUIRES_CALENDAR/);
    assert.match(entrypoint, /GOOGLE_TASKS_CANARY_WORKER_EXITED/);
    assert.ok(entrypoint.indexOf("migrate-session-model.sh") < entrypoint.indexOf("google-tasks-worker-main.js"));
    assert.match(entrypoint, /wait "\$gateway_pid" "\$reminder_pid" "\$google_tasks_pid"/);
    assert.match(entrypoint, /JARVIS_SCHEDULE_ICS_GZIP_BASE64/);
    assert.match(entrypoint, /schedule-import\.js/);
  });

  it("keeps an enabled Tasks lease alive during long idle poll waits without provider work", async () => {
    const main = await text("plugins/jarvis-tools/src/google-tasks-worker-main.ts");
    assert.match(main, /GOOGLE_TASKS_CANARY_LEASE_TTL_MS/);
    assert.match(main, /GOOGLE_TASKS_CANARY_LEASE_TTL_MS \/ 3/);
    assert.match(main, /store\.renewGoogleTasksCanaryLease\(lease\)/);
  });

  it("runs every built JavaScript helper through Node under gosu", async () => {
    const entrypoint = await text("deploy/railway-entrypoint.sh");
    const helperLines = entrypoint
      .split(/\r?\n/)
      .filter((line) => line.includes("/app/plugins/jarvis-tools/dist/") && line.includes(".js"));
    const legacySeedLine = helperLines.find((line) => line.includes("/legacy-seed.js"));
    assert.ok(legacySeedLine, "missing legacy seed invocation");

    const invocationPrefix = legacySeedLine.slice(0, legacySeedLine.indexOf(" /app/"));
    const directory = await mkdtemp(path.join(tmpdir(), "jarvis-railway-invocation-"));
    try {
      await writeFile(path.join(directory, "gosu"), "#!/usr/bin/env bash\nshift\nexec \"$@\"\n", "utf8");
      await writeFile(path.join(directory, "helper.js"), "process.stdout.write('HELPER_OK');\n", "utf8");
      await chmod(path.join(directory, "gosu"), 0o755);
      await chmod(path.join(directory, "helper.js"), 0o644);

      const result = spawnSync("bash", ["-c", `PATH="$PWD:$PATH"; ${invocationPrefix} ./helper.js`], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "HELPER_OK");
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    assert.equal(helperLines.length, 5);
    assert.ok(helperLines.every((line) => /^\s*gosu node node \/app\/plugins\/jarvis-tools\/dist\/[a-z-]+\.js/.test(line)));
  });

  it("requires primary free-busy, primary details, and managed agenda readiness without logging private calendar data", async () => {
    const readiness = await text("plugins/jarvis-tools/src/calendar-readiness.ts");
    assert.match(readiness, /queryFreeBusy\(\[primaryCalendarId, managedCalendarId\]/);
    assert.match(readiness, /listAgenda\(primaryCalendarId, start, end, true\)/);
    assert.match(readiness, /listAgenda\(managedCalendarId/);
    assert.match(readiness, /GOOGLE_CALENDAR_READINESS_START checks=3/);
    assert.match(readiness, /GOOGLE_CALENDAR_READY checks=3 freebusy=ok primary_agenda=ok managed_agenda=ok/);
    assert.doesNotMatch(readiness, /console\.log|JSON\.stringify\(.*managedCalendarId/);
  });

  it("keeps the Railway gateway private and exposes only narrow Jarvis tools", async () => {
    const config = JSON5.parse<{
      models?: unknown;
      gateway: { bind: string; tailscale?: unknown };
      agents: { defaults: { workspace: string; sandbox: { mode: string }; model: { primary: string }; models: Record<string, { agentRuntime?: { id?: string } }> } };
      channels: { telegram: { dmPolicy: string; allowFrom: string[]; groupPolicy: string; webhookUrl?: string; richMessages: boolean; errorPolicy: string; capabilities: { inlineButtons: string }; streaming: { mode: string }; actions: { sendMessage: boolean } } };
      commands: { native: boolean; nativeSkills: boolean };
      tools: { profile: string; allow: string[]; deny: string[] };
      plugins: { entries: { "jarvis-tools": { config: { importDirectory: string; databasePath: string } } } };
    }>(await text("config/openclaw.railway.json5"));
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(config.gateway.tailscale, undefined);
    assert.equal(config.agents.defaults.workspace, "/data/jarvis-v1/workspace");
    assert.equal(config.agents.defaults.sandbox.mode, "off");
    assert.equal(config.agents.defaults.model.primary, "openai/gpt-5.6-luna");
    assert.equal(config.agents.defaults.models["openai/gpt-5.6-luna"]?.agentRuntime?.id, "openclaw");
    assert.equal(config.models, undefined, "Railway must use the direct OpenAI provider rather than a custom endpoint");
    assert.equal(config.channels.telegram.dmPolicy, "allowlist");
    assert.deepEqual(config.channels.telegram.allowFrom, ["${TELEGRAM_OWNER_ID}"]);
    assert.equal(config.channels.telegram.groupPolicy, "disabled");
    assert.equal(config.channels.telegram.webhookUrl, undefined);
    assert.equal(config.channels.telegram.richMessages, false);
    assert.equal(config.channels.telegram.errorPolicy, "silent");
    assert.equal(config.channels.telegram.capabilities.inlineButtons, "dm");
    assert.equal(config.channels.telegram.streaming.mode, "off");
    assert.equal(config.channels.telegram.actions.sendMessage, true);
    assert.equal(config.commands.native, false);
    assert.equal(config.commands.nativeSkills, false);
    const manifest = JSON.parse(await text("plugins/jarvis-tools/openclaw.plugin.json")) as {
      contracts: { tools: string[] };
    };
    assert.equal(config.tools.profile, "full");
    assert.deepEqual(config.tools.allow, manifest.contracts.tools);
    assert.ok(config.tools.allow.every((name) => !name.includes("*") && !name.startsWith("group:")));
    for (const denied of ["gateway", "nodes", "cron", "exec", "browser", "message", "group:fs", "group:automation"]) {
      assert.ok(config.tools.deny.includes(denied), `missing deny rule: ${denied}`);
    }
    assert.equal(config.plugins.entries["jarvis-tools"].config.importDirectory, "/data/jarvis-v1/imports");
    assert.equal(config.plugins.entries["jarvis-tools"].config.databasePath, "${JARVIS_DATABASE_PATH}");
  });

  it("removes only the exact thirteen retired automations after the gateway is ready", async () => {
    const entrypoint = await text("deploy/railway-entrypoint.sh");
    const automations = await text("deploy/configure-automations.sh");
    const dockerfile = await text("Dockerfile");
    const dockerignore = await text(".dockerignore");

    assert.match(entrypoint, /openclaw cron status/);
    assert.match(entrypoint, /configure-automations\.sh/);
    assert.match(entrypoint, /trap .*TERM/);
    assert.match(entrypoint, /trap .*INT/);
    assert.match(dockerfile, /COPY deploy\/configure-automations\.sh/);
    assert.doesNotMatch(dockerignore, /^deploy\/configure-automations\.sh$/m);

    assert.match(automations, /openclaw cron list --all --json/);
    assert.match(automations, /openclaw cron rm/);
    assert.doesNotMatch(automations, /openclaw cron add|--model|--message|\*/);
    const retired = [...automations.matchAll(/^\s*'((?:jarvis-v1\.)[^']+)'$/gm)].map((match) => match[1]!);
    assert.equal(retired.length, 13);
    assert.equal(new Set(retired).size, 13);
    assert.match(automations, /declarationKey/);
    assert.match(automations, /AUTOMATIONS_OK declarations=0/);
    assert.match(entrypoint, /RAILWAY_AUTOMATIONS_READY declarations=0/);
  });

  it("uses the supported gateway API to clear stale Telegram session model overrides", async () => {
    const entrypoint = await text("deploy/railway-entrypoint.sh");
    const migration = await text("deploy/migrate-session-model.sh");
    const dockerfile = await text("Dockerfile");
    assert.match(entrypoint, /migrate-session-model\.sh/);
    assert.match(dockerfile, /COPY deploy\/migrate-session-model\.sh/);
    assert.match(migration, /gateway call sessions\.list/);
    assert.match(migration, /gateway call sessions\.patch/);
    assert.match(migration, /model:\s*null/);
    assert.doesNotMatch(migration, /sqlite|\.db|\.sqlite/i);
    assert.match(migration, /SESSION_MODEL_MIGRATION_OK/);
    assert.match(migration, /SESSION_MODEL_MIGRATION_BLOCKED/);
  });

  it("documents immutable migration namespace, previous deployment capture, backup limitation and rollback", async () => {
    const runbook = await text("docs/railway-runbook.md");
    assert.match(runbook, /railway deployment list --service jarvis-telegram --environment production --json/);
    assert.match(runbook, /previous-deployment-id\.txt/);
    assert.match(runbook, /ConvertFrom-Json/);
    assert.match(runbook, /previousDeploymentId/);
    assert.match(
      runbook,
      /Set-Content -LiteralPath 'migration-backups\/previous-deployment-id\.txt' -Value \$previousDeploymentId -NoNewline/,
    );
    const status = await text("STATUS.md");
    assert.doesNotMatch(runbook, /currently observed successful deployment is `[^`]+`/i);
    assert.doesNotMatch(runbook, /Set-Content[^\n]+["'][0-9a-f-]{36}["']/i);
    assert.doesNotMatch(status, /current successful production deployment is `[0-9a-f-]{36}`/i);
    assert.match(runbook, /\/data\/jarvis-v1/);
    assert.match(runbook, /existing \/data contents/i);
    assert.match(runbook, /SSH key/i);
    assert.match(runbook, /railway volume files download/);
    assert.match(runbook, /scripts\/sqlite-snapshot\.ts restore/);
    assert.match(runbook, /Do not overwrite the volume root/);
    assert.doesNotMatch(runbook, /railway volume files upload[^\n]+\/ --overwrite/);
    assert.match(runbook, /Live Railway snapshot\/restore proof remains outstanding/);
    assert.match(runbook, /Rollback/i);
    assert.match(runbook, /RAILWAY_RUN_UID=0/);
    assert.match(runbook, /backup is not a first-deploy gate/i);
  });

  it("excludes local secrets, dependencies, build output and private data from the image context", async () => {
    const ignore = await text(".dockerignore");
    for (const entry of [".git", "node_modules", ".env", "*.pdf", "*.ics", "*.sqlite", "backups"]) {
      assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
  });
});
