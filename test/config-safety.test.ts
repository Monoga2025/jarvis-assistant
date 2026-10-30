import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import JSON5 from "json5";

const root = path.resolve(import.meta.dirname, "..");

interface OpenClawTemplate {
  models?: unknown;
  gateway: { bind: string; auth: { mode: string; token: string; allowTailscale: boolean }; tailscale: { mode: string } };
  channels: { telegram: { dmPolicy: string; allowFrom: string[]; groupPolicy: string; groups: Record<string, unknown>; richMessages: boolean; errorPolicy: string; capabilities: { inlineButtons: string }; streaming: { mode: string } } };
  commands: { native: boolean; nativeSkills: boolean };
  agents: { defaults: { heartbeat: { every: string }; model: { primary: string; fallbacks: string[] }; modelPolicy: { allow: string[] }; models: Record<string, { agentRuntime?: { id?: string } }>; thinkingDefault: string; sandbox: { backend: string; mode: string; docker: { image: string } } } };
  cron: { skipMissedJobs: boolean };
  tools: { profile: string; allow: string[]; deny: string[]; sandbox: { tools: { allow: string[] } }; exec: { security: string }; agentToAgent: { enabled: boolean } };
}

describe("production configuration safety", () => {
  it("pins one model and closes gateway, Telegram groups, runtime, and automation mutation", async () => {
    const text = await readFile(path.join(root, "config/openclaw.production.json5"), "utf8");
    const config = JSON5.parse<OpenClawTemplate>(text);
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(config.gateway.auth.mode, "token");
    assert.equal(config.gateway.auth.allowTailscale, false);
    assert.equal(config.gateway.tailscale.mode, "serve");
    assert.equal(config.channels.telegram.dmPolicy, "allowlist");
    assert.equal(config.channels.telegram.groupPolicy, "disabled");
    assert.deepEqual(config.channels.telegram.groups, {});
    assert.equal(config.channels.telegram.allowFrom.length, 1);
    assert.equal(config.agents.defaults.model.primary, "openai/gpt-5.6-luna");
    assert.deepEqual(config.agents.defaults.model.fallbacks, []);
    assert.deepEqual(config.agents.defaults.modelPolicy.allow, ["openai/gpt-5.6-luna"]);
    assert.equal(config.agents.defaults.models["openai/gpt-5.6-luna"]?.agentRuntime?.id, "openclaw");
    assert.equal(config.agents.defaults.thinkingDefault, "low");
    assert.equal(config.models, undefined, "a custom provider or compatibility proxy must not replace direct OpenAI");
    assert.equal(config.agents.defaults.heartbeat.every, "0m");
    assert.equal(config.channels.telegram.richMessages, false);
    assert.equal(config.channels.telegram.errorPolicy, "silent");
    assert.equal(config.channels.telegram.capabilities.inlineButtons, "dm");
    assert.equal(config.channels.telegram.streaming.mode, "off");
    assert.equal(config.commands.native, false);
    assert.equal(config.commands.nativeSkills, false);
    assert.equal(config.agents.defaults.sandbox.backend, "podman");
    assert.equal(config.agents.defaults.sandbox.mode, "all");
    assert.equal(config.agents.defaults.sandbox.docker.image, "openclaw-sandbox:bookworm-slim");
    assert.equal(config.cron.skipMissedJobs, true);
    const manifest = JSON.parse(await readFile(path.join(root, "plugins/jarvis-tools/openclaw.plugin.json"), "utf8")) as {
      contracts: { tools: string[] };
    };
    assert.equal(config.tools.profile, "full");
    assert.deepEqual(config.tools.allow, manifest.contracts.tools);
    assert.deepEqual(config.tools.sandbox.tools.allow, manifest.contracts.tools);
    assert.ok(config.tools.allow.every((name) => !name.includes("*") && !name.startsWith("group:")));
    assert.equal(config.tools.exec.security, "deny");
    assert.equal(config.tools.agentToAgent.enabled, false);
    assert.ok(config.tools.deny.includes("group:automation"));
    assert.ok(config.tools.deny.includes("group:fs"));
    assert.ok(config.tools.deny.includes("group:web"));
    assert.ok(config.tools.deny.includes("message"));
  });

  it("removes fixed agent-turn declarations and stale model pins", async () => {
    const automation = await readFile(path.join(root, "deploy/configure-automations.sh"), "utf8");
    assert.doesNotMatch(automation, /openclaw cron add|--model|--message/);
    assert.match(automation, /AUTOMATIONS_OK declarations=0/);
  });

  it("packages only built runtime files and declares exact runtime dependencies", async () => {
    const packageText = await readFile(path.join(root, "plugins/jarvis-tools/package.json"), "utf8");
    const packageJson = JSON.parse(packageText) as {
      files?: string[];
      dependencies?: Record<string, string>;
      openclaw?: { extensions?: string[]; runtimeExtensions?: string[] };
    };
    assert.deepEqual(packageJson.files, ["dist", "openclaw.plugin.json"]);
    assert.deepEqual(packageJson.openclaw?.extensions, ["./dist/index.js"]);
    assert.deepEqual(packageJson.openclaw?.runtimeExtensions, ["./dist/index.js"]);
    assert.equal(packageJson.dependencies?.["pdfjs-dist"], "5.4.149");
    assert.equal(packageJson.dependencies?.typebox, "1.3.17");
  });

  it("fails closed on a missing sandbox image and enables the service only after preflight", async () => {
    const preflight = await readFile(path.join(root, "deploy/preflight.sh"), "utf8");
    const configure = await readFile(path.join(root, "deploy/configure-openclaw.sh"), "utf8");
    assert.match(preflight, /podman image exists/);
    assert.match(preflight, /SANDBOX_IMAGE/);
    assert.ok(configure.indexOf("preflight.sh") < configure.indexOf("systemctl enable --now"));
  });

  it("uses the service paths in smoke checks and pauses the service for WAL-safe backup", async () => {
    const smoke = await readFile(path.join(root, "deploy/smoke-test.sh"), "utf8");
    const backup = await readFile(path.join(root, "deploy/backup.sh"), "utf8");
    assert.match(smoke, /OPENCLAW_CONFIG_PATH=\/var\/lib\/openclaw\/openclaw\.json5/);
    assert.match(smoke, /OPENCLAW_STATE_DIR=\/var\/lib\/openclaw/);
    assert.match(smoke, /preserve-env=OPENCLAW_CONFIG_PATH,OPENCLAW_STATE_DIR/);
    assert.ok(backup.indexOf("systemctl stop openclaw.service") < backup.indexOf("wal_checkpoint"));
    assert.ok(backup.indexOf("wal_checkpoint") < backup.indexOf("tar --exclude"));
    assert.match(backup, /trap .*restart/);
  });

  it("documents couple consent, evidence-based rewards, and the Telegram voice-call boundary", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    const policy = await readFile(path.join(root, "workspace/skills/jarvis-os/SKILL.md"), "utf8");
    const agents = await readFile(path.join(root, "workspace/AGENTS.md"), "utf8");
    assert.match(policy, /Sam.*consentimiento.*pendiente/is);
    assert.match(policy, /45 minutos.*cierre diario.*compromisos críticos/is);
    assert.match(agents, /no puede otorgar.*consentimiento/is);
    assert.match(readme, /Bot API.*cannot initiate.*voice call/is);
    assert.match(readme, /voice notes.*later optional feature/is);
    assert.match(readme, /no paid TTS dependency/i);
  });
});
