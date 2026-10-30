import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoogleDriveClient, type GoogleDriveTokenProvider } from "../plugins/jarvis-tools/src/drive-client.js";
import type { GoogleDriveFileWire } from "../plugins/jarvis-tools/src/drive-contract.js";

function mockTokenProvider(token = "valid-drive-token"): GoogleDriveTokenProvider {
  return {
    getAccessToken: async () => token,
  };
}

describe("GoogleDriveClient", () => {
  it("fetches single page of allowlisted files and normalizes them", async () => {
    const filesWire: GoogleDriveFileWire[] = [
      {
        id: "file-1",
        name: "Guia1.pdf",
        mimeType: "application/pdf",
        parents: ["folder-materiales"],
        modifiedTime: "2026-09-01T10:00:00.000Z",
        size: "1024",
        webViewLink: "https://drive.google.com/file/d/file-1/view",
      },
    ];

    const client = new GoogleDriveClient(mockTokenProvider(), {
      fetchFn: async (url, options) => {
        const urlDecoded = decodeURIComponent(url.toString().replace(/\+/g, " "));
        assert.match(urlDecoded, /https:\/\/www\.googleapis\.com\/drive\/v3\/files/);
        assert.match(urlDecoded, /'folder-materiales' in parents/);
        assert.match(urlDecoded, /trashed = false/);
        assert.equal((options?.headers as Record<string, string>)?.authorization, "Bearer valid-drive-token");
        return new Response(JSON.stringify({
          files: filesWire,
          incompleteSearch: false,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await client.listFolderFiles({
      driveAccountId: "acc-alex",
      sourceFolderId: "folder-materiales",
    });

    assert.equal(result.status, "complete");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.driveFileId, "file-1");
    assert.equal(result.files[0]?.size, 1024);
  });

  it("handles bounded pagination with nextPageToken up to maxPages", async () => {
    let pageCount = 0;
    const client = new GoogleDriveClient(mockTokenProvider(), {
      fetchFn: async () => {
        pageCount += 1;
        const hasNext = pageCount === 1;
        return new Response(JSON.stringify({
          files: [{
            id: `file-p${pageCount}`,
            name: `Doc_${pageCount}.pdf`,
            mimeType: "application/pdf",
            parents: ["folder-materiales"],
            modifiedTime: "2026-09-01T10:00:00.000Z",
          }],
          nextPageToken: hasNext ? "token-p2" : undefined,
          incompleteSearch: false,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await client.listFolderFiles({
      driveAccountId: "acc-alex",
      sourceFolderId: "folder-materiales",
      maxPages: 5,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.files.length, 2);
    assert.equal(pageCount, 2);
  });

  it("flags status as incomplete when incompleteSearch is true", async () => {
    const client = new GoogleDriveClient(mockTokenProvider(), {
      fetchFn: async () => new Response(JSON.stringify({
        files: [],
        incompleteSearch: true,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const result = await client.listFolderFiles({
      driveAccountId: "acc-alex",
      sourceFolderId: "folder-materiales",
    });

    assert.equal(result.status, "incomplete");
  });

  it("filters out or throws on unexpected file outside allowlisted folder", async () => {
    const client = new GoogleDriveClient(mockTokenProvider(), {
      fetchFn: async () => new Response(JSON.stringify({
        files: [{
          id: "leaked-file",
          name: "Secret.txt",
          mimeType: "text/plain",
          parents: ["unauthorized-folder"],
          modifiedTime: "2026-09-01T10:00:00.000Z",
        }],
        incompleteSearch: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await assert.rejects(
      () => client.listFolderFiles({
        driveAccountId: "acc-alex",
        sourceFolderId: "folder-materiales",
      }),
      /not inside the allowlisted folder/i,
    );
  });
});
