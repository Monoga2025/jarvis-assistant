import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DriveStore } from "../plugins/jarvis-tools/src/drive-store.js";
import type { DriveFileMetadata } from "../plugins/jarvis-tools/src/drive-contract.js";

async function withTempDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-drive-test-"));
  const dbPath = path.join(dir, "jarvis.sqlite");
  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fileA: DriveFileMetadata = {
  driveAccountId: "acc-alex",
  sourceFolderId: "folder-materiales",
  driveFileId: "file-A",
  name: "Mecanica_Solidos_Taller1.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-01T12:00:00.000Z",
  size: 512000,
  webViewLink: "https://drive.google.com/file/d/file-A/view",
  providerChecksum: "hashA",
  metadataHash: "canonicalHashA",
  state: "active",
  indexedAt: "2026-09-10T10:00:00.000Z",
};

const fileB: DriveFileMetadata = {
  driveAccountId: "acc-alex",
  sourceFolderId: "folder-materiales",
  driveFileId: "file-B",
  name: "Formulas_Termodinamica.pdf",
  mimeType: "application/pdf",
  modifiedTime: "2026-09-02T12:00:00.000Z",
  size: 1024000,
  webViewLink: "https://drive.google.com/file/d/file-B/view",
  providerChecksum: "hashB",
  metadataHash: "canonicalHashB",
  state: "active",
  indexedAt: "2026-09-10T10:00:00.000Z",
};

describe("DriveStore", () => {
  it("indexes files idempotently and queries active files by keyword", async () => {
    await withTempDb(async (dbPath) => {
      const store = new DriveStore(dbPath);
      try {
        const syncResult = store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA, fileB],
          isComplete: true,
        });

        assert.equal(syncResult.activeCount, 2);
        assert.equal(syncResult.staleCount, 0);

        const listAll = store.listMaterials({ query: "Termodinamica" });
        assert.equal(listAll.length, 1);
        assert.equal(listAll[0]?.name, "Formulas_Termodinamica.pdf");
        assert.equal(listAll[0]?.webViewLink, "https://drive.google.com/file/d/file-B/view");

        // Re-syncing same files should be idempotent
        const resyncResult = store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA, fileB],
          isComplete: true,
        });
        assert.equal(resyncResult.unchangedCount, 2);
      } finally {
        store.close();
      }
    });
  });

  it("marks absent files stale on complete sync without deleting them", async () => {
    await withTempDb(async (dbPath) => {
      const store = new DriveStore(dbPath);
      try {
        store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA, fileB],
          isComplete: true,
        });

        // Next complete sync only contains fileA; fileB is absent
        const sync2 = store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA],
          isComplete: true,
        });

        assert.equal(sync2.activeCount, 1);
        assert.equal(sync2.staleCount, 1);

        const activeFiles = store.listMaterials({ state: "active" });
        assert.equal(activeFiles.length, 1);
        assert.equal(activeFiles[0]?.driveFileId, "file-A");

        const staleFiles = store.listMaterials({ state: "stale_or_out_of_scope" });
        assert.equal(staleFiles.length, 1);
        assert.equal(staleFiles[0]?.driveFileId, "file-B");
      } finally {
        store.close();
      }
    });
  });

  it("preserves active state on incomplete sync when files are absent", async () => {
    await withTempDb(async (dbPath) => {
      const store = new DriveStore(dbPath);
      try {
        store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA, fileB],
          isComplete: true,
        });

        // An incomplete sync (e.g. timeout / error) with only fileA should NOT mark fileB stale
        const syncIncomplete = store.syncFiles({
          driveAccountId: "acc-alex",
          sourceFolderId: "folder-materiales",
          files: [fileA],
          isComplete: false,
        });

        assert.equal(syncIncomplete.status, "incomplete");
        assert.equal(syncIncomplete.staleCount, 0);

        const activeFiles = store.listMaterials({ state: "active" });
        assert.equal(activeFiles.length, 2);
      } finally {
        store.close();
      }
    });
  });
});
