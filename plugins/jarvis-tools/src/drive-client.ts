import {
  type DriveFileMetadata,
  type GoogleDriveFileWire,
  normalizeDriveFile,
} from "./drive-contract.js";

export interface GoogleDriveTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface ListFolderFilesOptions {
  driveAccountId: string;
  sourceFolderId: string;
  maxPages?: number | undefined;
  pageSize?: number | undefined;
}

export interface ListFolderFilesResult {
  status: "complete" | "incomplete";
  files: DriveFileMetadata[];
  totalScanned: number;
}

export class GoogleDriveClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly tokenProvider: GoogleDriveTokenProvider,
    options?: { fetchFn?: typeof fetch },
  ) {
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async listFolderFiles(options: ListFolderFilesOptions): Promise<ListFolderFilesResult> {
    const maxPages = options.maxPages ?? 5;
    const pageSize = options.pageSize ?? 100;
    const token = await this.tokenProvider.getAccessToken();

    let pageToken: string | undefined;
    let page = 0;
    let isIncomplete = false;
    const files: DriveFileMetadata[] = [];
    let totalScanned = 0;

    do {
      page += 1;
      const params = new URLSearchParams({
        q: `'${options.sourceFolderId}' in parents and trashed = false`,
        fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed,md5Checksum)",
        pageSize: pageSize.toString(),
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await this.fetchFn(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });

      if (!response.ok) {
        return {
          status: "incomplete",
          files,
          totalScanned,
        };
      }

      const data = (await response.json()) as {
        files?: GoogleDriveFileWire[];
        nextPageToken?: string;
        incompleteSearch?: boolean;
      };

      if (data.incompleteSearch) {
        isIncomplete = true;
      }

      const pageFiles = data.files ?? [];
      for (const raw of pageFiles) {
        totalScanned += 1;
        const normalized = normalizeDriveFile(options.driveAccountId, options.sourceFolderId, raw);
        files.push(normalized);
      }

      pageToken = data.nextPageToken;
    } while (pageToken && page < maxPages);

    if (pageToken && page >= maxPages) {
      isIncomplete = true;
    }

    return {
      status: isIncomplete ? "incomplete" : "complete",
      files,
      totalScanned,
    };
  }
}
