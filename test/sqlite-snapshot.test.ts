import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../scripts/sqlite-snapshot.js";
import { LegacyStore, seedVerifiedLegacyRecords } from "../plugins/jarvis-tools/src/legacy.js";

const directories: string[] = [];
const candidateRevision = "a".repeat(40);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-snapshot-"));
  directories.push(root);
  const sourcePath = path.join(root, "source.sqlite");
  const store = new LegacyStore(sourcePath);
  seedVerifiedLegacyRecords(store, "2026-09-09T10:00:00-05:00");
  store.close();
  const writer = new DatabaseSync(sourcePath);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=7; CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT) WITHOUT ROWID; INSERT INTO owners VALUES ('alex', 'Alex');");
  return { root, sourcePath, writer, outputDirectory: path.join(root, "snapshot") };
}
afterEach(async () => {
  for (const root of directories.splice(0)) {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

describe("consistent SQLite snapshot and isolated restore", () => {
  it("rejects foreign-key violations during create, verify and restore without repairing the source", async () => {
    const f = await fixture();
    try {
      f.writer.exec("CREATE TABLE children(owner_id TEXT REFERENCES owners(id));");
      const manifest = await createSnapshot({ ...f, candidateRevision, deploymentId: "isolated-fixture" });
      f.writer.exec("PRAGMA foreign_keys=OFF; INSERT INTO children VALUES('orphan');");
      await assert.rejects(createSnapshot({ ...f, outputDirectory: path.join(f.root, "invalid"), candidateRevision, deploymentId: "isolated-fixture" }), /foreign.key/i);
      assert.equal(f.writer.prepare("SELECT COUNT(*) AS count FROM children").get()?.count, 1);
      const altered = new DatabaseSync(path.join(f.outputDirectory, "jarvis.sqlite"));
      altered.exec("PRAGMA foreign_keys=OFF; INSERT INTO children VALUES('orphan');");
      altered.close();
      manifest.sqliteSha256 = createHash("sha256").update(await readFile(path.join(f.outputDirectory, "jarvis.sqlite"))).digest("hex");
      await writeFile(path.join(f.outputDirectory, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(verifySnapshot(f.outputDirectory), /foreign.key/i);
      await assert.rejects(restoreSnapshot({ snapshotDirectory: f.outputDirectory, restoreDirectory: path.join(f.root, "restore"),
        expectedCandidateRevision: candidateRevision, expectedSchemaSha256: manifest.database.schemaSha256 }), /foreign.key/i);
    } finally { f.writer.close(); }
  });

  it("rejects oversized sources and excessive table counts before unbounded memory allocation", async () => {
    const f = await fixture();
    f.writer.close();
    // Sparse extension proves the size gate without constructing a large Buffer or fixture payload.
    await truncate(f.sourcePath, 64 * 1024 * 1024 + 1);
    await assert.rejects(createSnapshot({ ...f, candidateRevision, deploymentId: "isolated-fixture" }), /size limit/i);
    const bounded = await fixture();
    try {
      bounded.writer.exec("CREATE TABLE many_rows(id INTEGER); WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM rows WHERE id<100001) INSERT INTO many_rows SELECT id FROM rows;");
      await assert.rejects(createSnapshot({ ...bounded, candidateRevision, deploymentId: "isolated-fixture" }), /row limit/i);
    } finally { bounded.writer.close(); }
  });
  it("restores WAL commits, IDs, ownership, reminder state and date-only precision with matching manifest", async () => {
    const f = await fixture();
    try {
      const manifest = await createSnapshot({ ...f, candidateRevision, deploymentId: "isolated-fixture" });
      assert.equal(manifest.database.userVersion, 7);
      assert.equal(manifest.database.tables.find((table) => table.name === "owners")?.rowCount, 1);
      f.writer.exec("INSERT INTO owners VALUES ('later', 'After snapshot');");
      const restoreDirectory = path.join(f.root, "restore");
      const restored = await restoreSnapshot({ snapshotDirectory: f.outputDirectory, restoreDirectory,
        expectedCandidateRevision: candidateRevision, expectedSchemaSha256: manifest.database.schemaSha256 });
      assert.deepEqual(restored.database, manifest.database);
      const store = new LegacyStore(path.join(restoreDirectory, "jarvis.sqlite"));
      try {
        const task = store.listTasks("all").find(({ id }) => id === 18);
        assert.equal(task?.dueDate, "2026-09-10");
        assert.equal(task?.dueAt, null);
        assert.ok(store.listReminders().every(({ status }) => status === "review_required"));
      } finally { store.close(); }
      const database = new DatabaseSync(path.join(restoreDirectory, "jarvis.sqlite"), { readOnly: true });
      try { assert.deepEqual(database.prepare("SELECT id FROM owners").all().map(({ id }) => id), ["alex"]); }
      finally { database.close(); }
      const serialized = await readFile(path.join(f.outputDirectory, "manifest.json"), "utf8");
      assert.ok(!serialized.includes("Preparar quiz"));
      assert.ok(!serialized.includes(f.sourcePath));
    } finally { f.writer.close(); }
  });

  it("rejects a corrupted snapshot and mismatched rollback candidate/schema without creating a restore", async () => {
    const f = await fixture();
    try {
      const manifest = await createSnapshot({ ...f, candidateRevision, deploymentId: "isolated-fixture" });
      const options = { snapshotDirectory: f.outputDirectory, restoreDirectory: path.join(f.root, "restore"),
        expectedCandidateRevision: candidateRevision, expectedSchemaSha256: manifest.database.schemaSha256 };
      await assert.rejects(restoreSnapshot({ ...options, expectedCandidateRevision: "b".repeat(40) }), /candidate/i);
      await assert.rejects(restoreSnapshot({ ...options, expectedSchemaSha256: "0".repeat(64) }), /schema/i);
      await writeFile(path.join(f.outputDirectory, "jarvis.sqlite"), "corrupt");
      await assert.rejects(verifySnapshot(f.outputDirectory), /checksum/i);
      await assert.rejects(restoreSnapshot(options), /checksum/i);
      await assert.rejects(readFile(path.join(options.restoreDirectory, "jarvis.sqlite")), { code: "ENOENT" });
    } finally { f.writer.close(); }
  });

  it("refuses existing output directories rather than overwriting any files", async () => {
    const f = await fixture();
    try {
      const options = { ...f, candidateRevision, deploymentId: "isolated-fixture" };
      const manifest = await createSnapshot(options);
      const before = await readFile(path.join(f.outputDirectory, "jarvis.sqlite"));
      await assert.rejects(createSnapshot(options), { code: "EEXIST" });
      await assert.rejects(restoreSnapshot({ snapshotDirectory: f.outputDirectory, restoreDirectory: f.root,
        expectedCandidateRevision: candidateRevision, expectedSchemaSha256: manifest.database.schemaSha256 }), { code: "EEXIST" });
      assert.deepEqual(await readFile(path.join(f.outputDirectory, "jarvis.sqlite")), before);
    } finally { f.writer.close(); }
  });
});
