import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AssistantModeStore } from "../plugins/jarvis-tools/src/assistant-mode.js";
import plugin from "../plugins/jarvis-tools/src/index.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-mode-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "jarvis.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AssistantModeStore", () => {
  it("defaults and fails closed to normal across missing or malformed legacy state", async () => {
    const file = await databasePath();
    const first = new AssistantModeStore(file, () => new Date("2026-09-08T12:00:00Z"));
    assert.deepEqual(first.get(), { mode: "normal", goal: null, updatedAt: "2026-09-08T12:00:00.000Z" });
    first.close();

    const restarted = new AssistantModeStore(file);
    assert.equal(restarted.get().mode, "normal");
    restarted.close();
  });

  it("persists sanitized bounded work goals and applies idempotent transitions", async () => {
    const file = await databasePath();
    const store = new AssistantModeStore(file, () => new Date("2026-09-08T13:00:00Z"));
    try {
      const first = store.set({ mode: "work", goal: "  Resolver\u0000 el taller de EDO  ", idempotencyKey: "turn-1", sourceSystem: "jarvis-agent" });
      const replay = store.set({ mode: "work", goal: "Resolver el taller de EDO", idempotencyKey: "turn-1", sourceSystem: "jarvis-agent" });
      assert.deepEqual(first, replay);
      assert.deepEqual(store.get(), { mode: "work", goal: "Resolver el taller de EDO", updatedAt: "2026-09-08T13:00:00.000Z" });
      assert.throws(() => store.set({ mode: "work", goal: "Otro objetivo", idempotencyKey: "turn-1", sourceSystem: "jarvis-agent" }), /idempotency/i);
      assert.throws(() => store.set({ mode: "work", goal: "x".repeat(241), idempotencyKey: "turn-2", sourceSystem: "jarvis-agent" }), /goal/i);
      store.set({ mode: "normal", idempotencyKey: "turn-3", sourceSystem: "jarvis-agent" });
      assert.equal(store.get().mode, "normal");
      assert.equal(store.get().goal, null);
    } finally {
      store.close();
    }
  });
});

describe("assistant mode plugin integration", () => {
  it("registers no slash commands and injects the current mode on every prompt", async () => {
    const file = await databasePath();
    const commands: string[] = [];
    const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
    let preparation: (() => Promise<readonly string[]>) | undefined;
    plugin.register({
      pluginConfig: {
        primaryCalendarId: "primary", managedCalendarId: "managed", importDirectory: "C:/bounded", databasePath: file,
        googleClientIdFile: "C:/credentials/id", googleClientSecretFile: "C:/credentials/secret", googleRefreshTokenFile: "C:/credentials/refresh",
      },
      registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { tools.push(tool); },
      registerCommand(command: { name: string }) { commands.push(command.name); },
      registerMemoryPromptPreparation(callback: () => Promise<readonly string[]>) { preparation = callback; },
      registerInteractiveHandler() {},
    } as never);

    assert.deepEqual(commands, []);
    assert.ok(preparation);
    assert.match((await preparation())[0] ?? "", /MODE_NORMAL/);
    assert.match((await preparation())[0] ?? "", /no ordenes ni fuerces/i);

    const setMode = tools.find(({ name }) => name === "assistant_mode_set");
    assert.ok(setMode);
    await setMode.execute("call-1", { mode: "work", goal: "Estudiar Circuitos", idempotencyKey: "mode-1" });
    const workPrompt = (await preparation())[0] ?? "";
    assert.match(workPrompt, /MODE_WORK/);
    assert.match(workPrompt, /Estudiar Circuitos/);
    assert.match(workPrompt, /salir.*lenguaje natural/i);
  });
});
