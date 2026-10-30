import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DriveStore } from "../plugins/jarvis-tools/src/drive-store.js";
import plugin, { TOOL_NAMES } from "../plugins/jarvis-tools/src/index.js";

async function withTempDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-drive-tools-test-"));
  const dbPath = path.join(dir, "jarvis.sqlite");
  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Drive tools integration", () => {
  it("exposes drive_materials_sync and drive_materials_list in TOOL_NAMES", () => {
    assert.ok((TOOL_NAMES as readonly string[]).includes("drive_materials_sync"));
    assert.ok((TOOL_NAMES as readonly string[]).includes("drive_materials_list"));
  });

  it("lists materials via drive_materials_list tool", async () => {
    await withTempDb(async (dbPath) => {
      const store = new DriveStore(dbPath);
      store.syncFiles({
        driveAccountId: "acc-alex",
        sourceFolderId: "folder-materiales",
        files: [{
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          driveFileId: "file-99",
          name: "Guia_Circuitos_Teoremas.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-09-01T10:00:00.000Z",
          size: 1024,
          webViewLink: "https://drive.google.com/file/d/file-99/view",
          providerChecksum: "hash99",
          metadataHash: "canonical99",
          state: "active",
          indexedAt: "2026-09-10T10:00:00.000Z",
        }],
        isComplete: true,
      });
      store.close();

      let listTool: { execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } | undefined;
      plugin.register({
        pluginConfig: {
          primaryCalendarId: "primary",
          managedCalendarId: "managed",
          importDirectory: "C:/imports",
          databasePath: dbPath,
          googleClientIdFile: "C:/id",
          googleClientSecretFile: "C:/secret",
          googleRefreshTokenFile: "C:/refresh",
        },
        registerTool(tool: { name?: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }) {
          if (tool.name === "drive_materials_list") listTool = tool;
        },
        registerCommand() {},
        registerMemoryPromptPreparation() {},
        registerInteractiveHandler() {},
      } as never);

      assert.ok(listTool);
      const rawResult = await listTool.execute("call-1", { query: "Circuitos" });
      const results = JSON.parse(rawResult.content.find((item) => item.type === "text")!.text!) as Array<{ name: string; webViewLink: string | null }>;
      assert.equal(results.length, 1);
      assert.equal(results[0]?.name, "Guia_Circuitos_Teoremas.pdf");
      assert.equal(results[0]?.webViewLink, "https://drive.google.com/file/d/file-99/view");
    });
  });
});
