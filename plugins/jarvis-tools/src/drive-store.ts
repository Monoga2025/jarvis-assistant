import { DatabaseSync } from "node:sqlite";
import type { DriveFileMetadata, DriveFileState, DriveSyncResult } from "./drive-contract.js";

interface SqlDriveRow {
  drive_account_id: string;
  source_folder_id: string;
  drive_file_id: string;
  name: string;
  mime_type: string;
  modified_time: string;
  size: number | null;
  web_view_link: string | null;
  provider_checksum: string | null;
  metadata_hash: string;
  state: DriveFileState;
  indexed_at: string;
}

export interface SyncFilesInput {
  driveAccountId: string;
  sourceFolderId: string;
  files: DriveFileMetadata[];
  isComplete: boolean;
}

export interface ListMaterialsFilter {
  query?: string | undefined;
  state?: DriveFileState | undefined;
  limit?: number | undefined;
}

export class DriveStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS jarvis_drive_materials (
        drive_account_id TEXT NOT NULL,
        source_folder_id TEXT NOT NULL,
        drive_file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        modified_time TEXT NOT NULL,
        size INTEGER,
        web_view_link TEXT,
        provider_checksum TEXT,
        metadata_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'stale_or_out_of_scope', 'unknown')),
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (drive_account_id, source_folder_id, drive_file_id)
      );
      CREATE INDEX IF NOT EXISTS jarvis_drive_materials_lookup ON jarvis_drive_materials(drive_account_id, source_folder_id, state);
    `);
  }

  close(): void {
    this.database.close();
  }

  syncFiles(input: SyncFilesInput): DriveSyncResult {
    let activeCount = 0;
    let unchangedCount = 0;
    let staleCount = 0;
    const now = new Date().toISOString();

    const findStmt = this.database.prepare(
      "SELECT metadata_hash, state FROM jarvis_drive_materials WHERE drive_account_id = ? AND source_folder_id = ? AND drive_file_id = ?",
    );

    const upsertStmt = this.database.prepare(`
      INSERT INTO jarvis_drive_materials (
        drive_account_id, source_folder_id, drive_file_id, name, mime_type,
        modified_time, size, web_view_link, provider_checksum, metadata_hash, state, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(drive_account_id, source_folder_id, drive_file_id) DO UPDATE SET
        name = excluded.name,
        mime_type = excluded.mime_type,
        modified_time = excluded.modified_time,
        size = excluded.size,
        web_view_link = excluded.web_view_link,
        provider_checksum = excluded.provider_checksum,
        metadata_hash = excluded.metadata_hash,
        state = 'active',
        indexed_at = excluded.indexed_at
    `);

    const activeIds = new Set<string>();

    for (const file of input.files) {
      activeIds.add(file.driveFileId);
      const existing = findStmt.get(input.driveAccountId, input.sourceFolderId, file.driveFileId) as { metadata_hash: string; state: string } | undefined;
      if (existing && existing.metadata_hash === file.metadataHash && existing.state === "active") {
        unchangedCount += 1;
        activeCount += 1;
        continue;
      }

      upsertStmt.run(
        input.driveAccountId,
        input.sourceFolderId,
        file.driveFileId,
        file.name,
        file.mimeType,
        file.modifiedTime,
        file.size,
        file.webViewLink,
        file.providerChecksum,
        file.metadataHash,
        file.indexedAt || now,
      );
      activeCount += 1;
    }

    if (input.isComplete) {
      const activeRows = this.database.prepare(
        "SELECT drive_file_id FROM jarvis_drive_materials WHERE drive_account_id = ? AND source_folder_id = ? AND state = 'active'",
      ).all(input.driveAccountId, input.sourceFolderId) as unknown as Array<{ drive_file_id: string }>;

      const markStaleStmt = this.database.prepare(
        "UPDATE jarvis_drive_materials SET state = 'stale_or_out_of_scope', indexed_at = ? WHERE drive_account_id = ? AND source_folder_id = ? AND drive_file_id = ?",
      );

      for (const row of activeRows) {
        if (!activeIds.has(row.drive_file_id)) {
          markStaleStmt.run(now, input.driveAccountId, input.sourceFolderId, row.drive_file_id);
          staleCount += 1;
        }
      }
    }

    return {
      status: input.isComplete ? "complete" : "incomplete",
      totalScanned: input.files.length,
      activeCount,
      staleCount,
      unchangedCount,
    };
  }

  listMaterials(filter?: ListMaterialsFilter): DriveFileMetadata[] {
    const state = filter?.state ?? "active";
    const limit = filter?.limit ?? 50;
    const query = filter?.query ? `%${filter.query.trim()}%` : null;

    let rows: SqlDriveRow[];
    if (query) {
      rows = this.database.prepare(`
        SELECT * FROM jarvis_drive_materials
        WHERE state = ? AND name LIKE ?
        ORDER BY name ASC
        LIMIT ?
      `).all(state, query, limit) as unknown as SqlDriveRow[];
    } else {
      rows = this.database.prepare(`
        SELECT * FROM jarvis_drive_materials
        WHERE state = ?
        ORDER BY name ASC
        LIMIT ?
      `).all(state, limit) as unknown as SqlDriveRow[];
    }

    return rows.map((row) => ({
      driveAccountId: row.drive_account_id,
      sourceFolderId: row.source_folder_id,
      driveFileId: row.drive_file_id,
      name: row.name,
      mimeType: row.mime_type,
      modifiedTime: row.modified_time,
      size: row.size,
      webViewLink: row.web_view_link,
      providerChecksum: row.provider_checksum,
      metadataHash: row.metadata_hash,
      state: row.state,
      indexedAt: row.indexed_at,
    }));
  }
}
