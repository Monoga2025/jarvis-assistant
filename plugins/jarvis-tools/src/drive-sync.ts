import type { DriveSyncResult } from "./drive-contract.js";
import type { GoogleDriveClient } from "./drive-client.js";
import type { DriveStore } from "./drive-store.js";

export async function syncDriveMaterials(
  client: GoogleDriveClient,
  store: DriveStore,
  options: { driveAccountId: string; sourceFolderId: string; maxPages?: number | undefined },
): Promise<DriveSyncResult> {
  const listing = await client.listFolderFiles({
    driveAccountId: options.driveAccountId,
    sourceFolderId: options.sourceFolderId,
    maxPages: options.maxPages,
  });

  return store.syncFiles({
    driveAccountId: options.driveAccountId,
    sourceFolderId: options.sourceFolderId,
    files: listing.files,
    isComplete: listing.status === "complete",
  });
}
