import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listNativeCommandSpecs } from "openclaw/plugin-sdk/native-command-registry";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin, { TOOL_NAMES } from "../plugins/jarvis-tools/src/index.js";

describe("Jarvis tool plugin contract", () => {
  it("exports only the narrow deterministic tool surface", () => {
    const metadata = getToolPluginMetadata(plugin);
    assert.ok(metadata);
    assert.equal(metadata.id, "jarvis-tools");
    assert.deepEqual(metadata.tools.map((tool) => tool.name), [...TOOL_NAMES]);
    assert.equal(metadata.tools.every((tool) => tool.optional), true);
    assert.equal(TOOL_NAMES.some((name) => /shell|exec|browser|file_read/.test(name)), false);
    for (const required of [
      "couple_record_shared_expense",
      "couple_record_settlement",
      "couple_summary",
      "coaching_record_checkin",
      "coaching_summary",
      "coaching_claim_proactive",
    ]) assert.ok((TOOL_NAMES as readonly string[]).includes(required), `missing narrow tool: ${required}`);
    assert.equal(TOOL_NAMES.some((name) => /consent|grant|bank_login|payment/.test(name)), false);
  });

  it("does not register or expose legacy slash commands", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const interactive: Array<{ channel: string; namespace: string }> = [];
    plugin.register({
      pluginConfig: {
        primaryCalendarId: "primary",
        managedCalendarId: "managed",
        importDirectory: "C:/bounded-imports",
        databasePath: "C:/bounded-data/jarvis.sqlite",
        googleClientIdFile: "C:/credentials/client-id",
        googleClientSecretFile: "C:/credentials/client-secret",
        googleRefreshTokenFile: "C:/credentials/refresh-token",
      },
      registerTool(tool: { name?: string }) { if (tool.name) tools.push(tool.name); },
      registerCommand(command: { name: string }) { commands.push(command.name); },
      registerMemoryPromptPreparation() {},
      registerInteractiveHandler(handler: { channel: string; namespace: string }) {
        interactive.push({ channel: handler.channel, namespace: handler.namespace });
      },
    } as never);
    assert.deepEqual(tools, [...TOOL_NAMES]);
    assert.deepEqual(commands, []);
    assert.deepEqual(interactive, [{ channel: "telegram", namespace: "jarvis" }]);
    const nativeCommandNames = new Set(listNativeCommandSpecs().map(({ name }) => name));
    assert.equal(nativeCommandNames.has("tasks"), true, "OpenClaw may retain its internal bootstrap command while Telegram hides the menu");
  });
});
