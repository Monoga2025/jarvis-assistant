import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", "dist", "imports", "backups"]);
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
];

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(fullPath));
    else result.push(fullPath);
  }
  return result;
}

const files = await filesUnder(root);
const findings: string[] = [];
for (const file of files) {
  if (/\.(?:png|jpg|jpeg|gif|pdf|ics|sqlite|age)$/i.test(file)) continue;
  const text = await readFile(file, "utf8");
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`possible secret in ${path.relative(root, file)}`);
  }
}

const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; engines?: Record<string, string> };
if (rootPackage.dependencies?.openclaw !== "2026.9.1") findings.push("openclaw dependency is not pinned to 2026.9.1");
if (rootPackage.engines?.node !== ">=24.15.0 <25") findings.push("Node engine is outside the reviewed range");

const pluginManifest = JSON.parse(await readFile(path.join(root, "plugins/jarvis-tools/openclaw.plugin.json"), "utf8")) as {
  contracts?: { tools?: string[] };
};
const declaredJarvisTools = pluginManifest.contracts?.tools ?? [];
for (const requiredTool of [
  "task_create", "task_complete", "reminder_create", "academic_fact_record", "study_handoff_create", "study_report_ingest", "study_material_record",
  "couple_record_shared_expense", "couple_record_settlement", "couple_summary", "coaching_record_checkin", "coaching_summary", "coaching_claim_proactive",
]) {
  if (!declaredJarvisTools.includes(requiredTool)) findings.push(`legacy capability tool is not declared: ${requiredTool}`);
}
if (declaredJarvisTools.some((name) => /consent|grant|payment|bank_login/.test(name))) findings.push("tool manifest exposes a forbidden consent, payment, or bank-login capability");
const isExactJarvisToolAllowlist = (allow: string[] | undefined) =>
  JSON.stringify(allow) === JSON.stringify(declaredJarvisTools)
  && allow?.every((name) => !name.includes("*") && !name.startsWith("group:"));

const configText = await readFile(path.join(root, "config/openclaw.production.json5"), "utf8");
const config = JSON5.parse<{ gateway?: { bind?: string; tailscale?: { mode?: string } }; channels?: { telegram?: { groupPolicy?: string } }; tools?: { profile?: string; allow?: string[]; deny?: string[]; sandbox?: { tools?: { allow?: string[] } } } }>(configText);
if (config.gateway?.bind !== "loopback") findings.push("gateway bind is not loopback");
if (config.gateway?.tailscale?.mode !== "serve") findings.push("Tailscale mode is not serve");
if (config.channels?.telegram?.groupPolicy !== "disabled") findings.push("Telegram groups are not disabled");
if (config.tools?.profile !== "full" || !isExactJarvisToolAllowlist(config.tools.allow)) findings.push("production tool allowlist does not exactly match declared Jarvis tools");
if (!isExactJarvisToolAllowlist(config.tools?.sandbox?.tools?.allow)) findings.push("production sandbox tool allowlist does not exactly match declared Jarvis tools");
for (const denied of ["exec", "browser", "group:fs", "group:automation"]) {
  if (!config.tools?.deny?.includes(denied)) findings.push(`required tool denial missing: ${denied}`);
}

const railwayText = await readFile(path.join(root, "config/openclaw.railway.json5"), "utf8");
const railwayConfig = JSON5.parse<{
  gateway?: { bind?: string; tailscale?: unknown };
  agents?: { defaults?: { workspace?: string; sandbox?: { mode?: string } } };
  channels?: { telegram?: { allowFrom?: string[]; groupPolicy?: string; webhookUrl?: string } };
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
}>(railwayText);
if (railwayConfig.gateway?.bind !== "loopback") findings.push("Railway gateway bind is not loopback");
if (railwayConfig.gateway?.tailscale !== undefined) findings.push("Railway config unexpectedly enables Tailscale");
if (railwayConfig.agents?.defaults?.workspace !== "/data/jarvis-v1/workspace") findings.push("Railway workspace is outside its isolated volume namespace");
if (railwayConfig.agents?.defaults?.sandbox?.mode !== "off") findings.push("Railway config requires an unavailable nested sandbox");
if (railwayConfig.channels?.telegram?.groupPolicy !== "disabled") findings.push("Railway Telegram groups are not disabled");
if (railwayConfig.channels?.telegram?.webhookUrl !== undefined) findings.push("Railway Telegram is not using default long polling");
if (railwayConfig.channels?.telegram?.allowFrom?.length !== 1) findings.push("Railway Telegram owner allowlist is not singular");
if (railwayConfig.tools?.profile !== "full" || !isExactJarvisToolAllowlist(railwayConfig.tools.allow)) findings.push("Railway tool allowlist does not exactly match declared Jarvis tools");
for (const denied of ["gateway", "nodes", "cron", "exec", "browser", "group:fs", "group:automation"]) {
  if (!railwayConfig.tools?.deny?.includes(denied)) findings.push(`Railway tool denial missing: ${denied}`);
}

const railwayManifest = JSON.parse(await readFile(path.join(root, "railway.json"), "utf8")) as {
  build?: { builder?: string; dockerfilePath?: string };
  deploy?: { restartPolicyType?: string; healthcheckPath?: string; cronSchedule?: string };
};
if (railwayManifest.build?.builder !== "DOCKERFILE" || railwayManifest.build?.dockerfilePath !== "Dockerfile") findings.push("Railway does not select the production Dockerfile");
if (railwayManifest.deploy?.restartPolicyType !== "ALWAYS") findings.push("Railway restart policy is not ALWAYS");
if (railwayManifest.deploy?.healthcheckPath !== undefined) findings.push("Railway declares a readiness endpoint that does not exist");
if (railwayManifest.deploy?.cronSchedule !== undefined) findings.push("Railway worker is incorrectly configured as platform cron");

const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
if (!/^FROM node:24\.15\.0-bookworm-slim AS build/m.test(dockerfile)) findings.push("Railway Node base is outside the reviewed runtime");
if (/podman|tailscale|funnel/i.test(dockerfile)) findings.push("Railway image includes forbidden VPS networking or nested-container dependencies");
const railwayEntrypoint = await readFile(path.join(root, "deploy/railway-entrypoint.sh"), "utf8");
if (!railwayEntrypoint.includes("export JARVIS_ROOT=/data/jarvis-v1")) findings.push("Railway entrypoint does not isolate persistent writes");
if (!railwayEntrypoint.includes('gosu node "$@" &')) findings.push("Railway gateway does not drop root before runtime");
if (!railwayEntrypoint.includes("openclaw cron status") || !railwayEntrypoint.includes("configure-automations.sh")) findings.push("Railway does not reconcile automations after Gateway readiness");
for (const requiredStartup of ["JARVIS_CALENDAR_ENABLED", "calendar-readiness.js", "legacy-seed.js", "reminder-worker.js", "JARVIS_SCHEDULE_ICS_GZIP_BASE64", "schedule-import.js"]) {
  if (!railwayEntrypoint.includes(requiredStartup)) findings.push(`Railway startup capability missing: ${requiredStartup}`);
}
if (!railwayEntrypoint.includes("GOOGLE_CALENDAR_DISABLED_STALE_FILES_REMOVED")) findings.push("Railway calendar disable path does not remove stale credentials explicitly");
if (railwayEntrypoint.includes("write_secret OPENAI_API_KEY")) findings.push("Railway persists an unused OpenAI API key file");
if (!railwayEntrypoint.includes("unset TELEGRAM_BOT_TOKEN") || !railwayEntrypoint.includes("unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN")) findings.push("Railway leaves file-backed secrets inherited by runtime subprocesses");
if (/set -x|printenv/.test(railwayEntrypoint)) findings.push("Railway entrypoint could print secret-bearing environment data");

const railwayRunbook = await readFile(path.join(root, "docs/railway-runbook.md"), "utf8");
const implementationStatus = await readFile(path.join(root, "STATUS.md"), "utf8");
if (/currently observed successful deployment is `[^`]+`/i.test(railwayRunbook)
  || /Set-Content[^\n]+["'][0-9a-f-]{36}["']/i.test(railwayRunbook)
  || /current successful production deployment is `[0-9a-f-]{36}`/i.test(implementationStatus)) {
  findings.push("Railway rollback documentation contains a stale deployment ID");
}

const schedule = JSON.parse(await readFile(path.join(root, "data/weekly-schedule.json"), "utf8")) as { classHoursPerWeek: number; classes: Array<{ start: string; end: string }> };
const hours = schedule.classes.reduce((sum, item) => {
  const [startHour, startMinute] = item.start.split(":").map(Number);
  const [endHour, endMinute] = item.end.split(":").map(Number);
  return sum + ((endHour ?? 0) * 60 + (endMinute ?? 0) - (startHour ?? 0) * 60 - (startMinute ?? 0)) / 60;
}, 0);
if (hours !== 32 || schedule.classHoursPerWeek !== 32) findings.push(`weekly class hours mismatch: computed ${hours}`);

const forbiddenArtifacts = files.filter((file) => /\.(?:pdf|ics|sqlite)$/i.test(file));
if (forbiddenArtifacts.length > 0) findings.push(`real-data-like artifacts present: ${forbiddenArtifacts.map((file) => path.relative(root, file)).join(", ")}`);

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`AUDIT_FAIL ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`AUDIT_OK files=${files.length} secrets=0 classHours=32 broadTools=denied\n`);
}
