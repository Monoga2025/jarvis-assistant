import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

interface DatabaseInventory {
  userVersion: number;
  schemaSha256: string;
  tables: { name: string; rowCount: number; rowsSha256: string }[];
}
export interface SnapshotManifest {
  formatVersion: 1;
  capturedAt: string;
  candidateRevision: string;
  deploymentId: string;
  sqliteSha256: string;
  database: DatabaseInventory;
}
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const databaseFile = (directory: string): string => path.join(directory, "jarvis.sqlite");
const manifestFile = (directory: string): string => path.join(directory, "manifest.json");
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_TABLE_ROWS = 100_000;

async function validateFileSize(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("SQLite input must be a regular file, not a link.");
  if (info.size > MAX_DATABASE_BYTES) throw new Error("SQLite size limit exceeded (64 MiB); operator review is required.");
}
async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function inspectDatabase(file: string): DatabaseInventory {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (!isDeepStrictEqual(database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"])) {
      throw new Error("SQLite integrity check failed.");
    }
    if (database.prepare("PRAGMA foreign_key_check").get()) throw new Error("SQLite foreign-key check failed.");
    const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
    const tables = schema.filter((row) => row.type === "table").map(({ name }) => {
      if (typeof name !== "string") throw new Error("Invalid table name.");
      const rowCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get()?.count);
      if (rowCount > MAX_TABLE_ROWS) throw new Error("SQLite table row limit exceeded (100000); operator review is required.");
      const statement = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
      statement.setReadBigInts(true);
      const hashes: string[] = [];
      for (const row of statement.iterate()) {
        const cells = Object.keys(row).sort().map((key) => {
          const value = row[key];
          return [key, value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value,
            value instanceof Uint8Array ? Buffer.from(value).toString("base64") : String(value)];
        });
        hashes.push(digest(JSON.stringify(cells)));
      }
      return { name, rowCount: hashes.length, rowsSha256: digest(hashes.sort().join("\n")) };
    });
    return { userVersion: Number(database.prepare("PRAGMA user_version").get()?.user_version),
      schemaSha256: digest(JSON.stringify(schema)), tables };
  } finally { database.close(); }
}

function validateIdentity(candidateRevision: string, deploymentId: string): void {
  if (!/^[a-f\d]{40}$/u.test(candidateRevision)) throw new Error("A full candidate commit revision is required.");
  if (!/^[\w.-]{1,100}$/u.test(deploymentId)) throw new Error("A deployment identity is required (use isolated-fixture for fixtures).");
}

export async function createSnapshot(input: {
  sourcePath: string;
  outputDirectory: string;
  candidateRevision: string;
  deploymentId: string;
}): Promise<SnapshotManifest> {
  validateIdentity(input.candidateRevision, input.deploymentId);
  await validateFileSize(input.sourcePath);
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    const logicalBytes = Number(source.prepare("PRAGMA page_count").get()?.page_count) * Number(source.prepare("PRAGMA page_size").get()?.page_size);
    if (logicalBytes > MAX_DATABASE_BYTES) throw new Error("SQLite size limit exceeded including WAL state (64 MiB).");
    // Exclusive directory creation prevents backup(), which overwrites its target, from clobbering a file.
    await mkdir(input.outputDirectory, { mode: 0o700 });
    // Node's SQLite backup API includes committed WAL state; a raw copy of the live main file does not.
    // https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options
    await backup(source, databaseFile(input.outputDirectory));
  } finally { source.close(); }
  await validateFileSize(databaseFile(input.outputDirectory));
  await chmod(databaseFile(input.outputDirectory), 0o600);
  const database = inspectDatabase(databaseFile(input.outputDirectory));
  const manifest: SnapshotManifest = { formatVersion: 1, capturedAt: new Date().toISOString(),
    candidateRevision: input.candidateRevision, deploymentId: input.deploymentId,
    sqliteSha256: await fileDigest(databaseFile(input.outputDirectory)), database };
  await writeFile(manifestFile(input.outputDirectory), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export async function verifySnapshot(directory: string): Promise<SnapshotManifest> {
  await validateFileSize(databaseFile(directory));
  for (const file of [manifestFile(directory), databaseFile(directory)]) {
    if (!(await lstat(file)).isFile()) throw new Error("Snapshot files must be regular files, not links.");
  }
  const manifest = JSON.parse(await readFile(manifestFile(directory), "utf8")) as SnapshotManifest;
  if (!manifest || manifest.formatVersion !== 1 || !/^[a-f\d]{64}$/u.test(manifest.sqliteSha256)) {
    throw new Error("Unsupported snapshot manifest.");
  }
  validateIdentity(manifest.candidateRevision, manifest.deploymentId);
  if (await fileDigest(databaseFile(directory)) !== manifest.sqliteSha256) throw new Error("Snapshot checksum mismatch.");
  const actual = inspectDatabase(databaseFile(directory));
  if (!isDeepStrictEqual(actual, manifest.database)) throw new Error("Snapshot inventory mismatch.");
  return manifest;
}

export async function restoreSnapshot(input: {
  snapshotDirectory: string;
  restoreDirectory: string;
  expectedCandidateRevision: string;
  expectedSchemaSha256: string;
}): Promise<SnapshotManifest> {
  const manifest = await verifySnapshot(input.snapshotDirectory);
  if (manifest.candidateRevision !== input.expectedCandidateRevision) throw new Error("Rollback candidate mismatch.");
  if (manifest.database.schemaSha256 !== input.expectedSchemaSha256) throw new Error("Rollback schema mismatch.");
  await mkdir(input.restoreDirectory, { mode: 0o700 });
  await copyFile(databaseFile(input.snapshotDirectory), databaseFile(input.restoreDirectory), constants.COPYFILE_EXCL);
  await chmod(databaseFile(input.restoreDirectory), 0o600);
  await writeFile(manifestFile(input.restoreDirectory), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return verifySnapshot(input.restoreDirectory);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`Required argument: ${name}`);
    return value;
  };
  let manifest: SnapshotManifest;
  switch (args[0]) {
    case "create":
      manifest = await createSnapshot({ sourcePath: path.resolve(flag("--source")), outputDirectory: path.resolve(flag("--output")),
        candidateRevision: flag("--candidate"), deploymentId: flag("--deployment") });
      break;
    case "verify": manifest = await verifySnapshot(path.resolve(flag("--snapshot"))); break;
    case "restore":
      manifest = await restoreSnapshot({ snapshotDirectory: path.resolve(flag("--snapshot")), restoreDirectory: path.resolve(flag("--output")),
        expectedCandidateRevision: flag("--candidate"), expectedSchemaSha256: flag("--schema") });
      break;
    default: throw new Error("Use create, verify, or restore; output directories must not exist.");
  }
  process.stdout.write(`${JSON.stringify({ status: "SQLITE_SNAPSHOT_OK", manifest })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error: unknown) => {
    process.stderr.write(`SQLITE_SNAPSHOT_FAILED ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
