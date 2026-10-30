import { createHash } from "node:crypto";

export const DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

export type DriveFileState = "active" | "stale_or_out_of_scope" | "unknown";

export interface GoogleDriveFileWire {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  trashed?: boolean;
  md5Checksum?: string;
}

export interface DriveFileMetadata {
  driveAccountId: string;
  sourceFolderId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  webViewLink: string | null;
  providerChecksum: string | null;
  metadataHash: string;
  state: DriveFileState;
  indexedAt: string;
}

export interface DriveSyncResult {
  status: "complete" | "incomplete" | "error";
  totalScanned: number;
  activeCount: number;
  staleCount: number;
  unchangedCount: number;
  error?: string;
}

export function validateDriveScope(scopes: string[]): boolean {
  if (!scopes.includes(DRIVE_METADATA_READONLY_SCOPE)) return false;
  const wideScopes = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.appdata",
  ];
  if (scopes.some((s) => wideScopes.includes(s))) return false;
  return true;
}

export function computeMetadataHash(fields: {
  driveAccountId: string;
  sourceFolderId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  webViewLink: string | null;
}): string {
  const canonical = {
    driveAccountId: fields.driveAccountId,
    sourceFolderId: fields.sourceFolderId,
    driveFileId: fields.driveFileId,
    name: fields.name,
    mimeType: fields.mimeType,
    modifiedTime: fields.modifiedTime,
    size: fields.size,
    webViewLink: fields.webViewLink,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function normalizeDriveFile(
  driveAccountId: string,
  sourceFolderId: string,
  raw: GoogleDriveFileWire,
  indexedAt: string = new Date().toISOString(),
): DriveFileMetadata {
  if (!raw.parents || !raw.parents.includes(sourceFolderId)) {
    throw new Error(`File ${raw.id} is not inside the allowlisted folder ${sourceFolderId}.`);
  }

  const size = raw.size ? Number.parseInt(raw.size, 10) : null;
  const webViewLink = raw.webViewLink ?? null;
  const providerChecksum = raw.md5Checksum ?? null;

  const metadataHash = computeMetadataHash({
    driveAccountId,
    sourceFolderId,
    driveFileId: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime,
    size,
    webViewLink,
  });

  return {
    driveAccountId,
    sourceFolderId,
    driveFileId: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime,
    size,
    webViewLink,
    providerChecksum,
    metadataHash,
    state: "active",
    indexedAt,
  };
}
