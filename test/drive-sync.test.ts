import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GoogleDriveClient } from "../plugins/jarvis-tools/src/drive-client.js";
import { DriveStore } from "../plugins/jarvis-tools/src/drive-store.js";
import { syncDriveMaterials } from "../plugins/jarvis-tools/src/drive-sync.js";
import type { GoogleDriveFileWire } from "../plugins/jarvis-tools/src/drive-contract.js";

async function withTempDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-drive-sync-test-"));
  const dbPath = path.join(dir, "jarvis.sqlite");
  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("syncDriveMaterials", () => {
  it("orchestrates client listing and store syncing", async () => {
    await withTempDb(async (dbPath) => {
      const store = new DriveStore(dbPath);
      const filesWire: GoogleDriveFileWire[] = [
        {
          id: "drive-doc-1",
          name: "Syllabus_Mecanica.pdf",
          mimeType: "application/pdf",
          parents: ["folder-materiales"],
          modifiedTime: "2026-09-01T12:00:00.000Z",
          size: "4096",
          webViewLink: "https://drive.google.com/file/d/drive-doc-1/view",
        },
      ];

      const client = new GoogleDriveClient(
        { getAccessToken: async () => "test-token" },
        {
          fetchFn: async () => new Response(JSON.stringify({
            files: filesWire,
            incompleteSearch: false,
          }), { status: 200, headers: { "content-type": "application/json" } }),
        },
      );

      try {
        const result = await syncDriveMaterials(client, store, {
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
        });

        assert.equal(result.status, "complete");
        assert.equal(result.activeCount, 1);
        assert.equal(result.totalScanned, 1);

        const materials = store.listMaterials({ query: "Syllabus" });
        assert.equal(materials.length, 1);
        assert.equal(materials[0]?.name, "Syllabus_Mecanica.pdf");
      } finally {
        store.close();
      }
    });
  });
});
