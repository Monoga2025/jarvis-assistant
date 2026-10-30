import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeMetadataHash,
  normalizeDriveFile,
  validateDriveScope,
  DRIVE_METADATA_READONLY_SCOPE,
  type GoogleDriveFileWire,
} from "../plugins/jarvis-tools/src/drive-contract.js";

describe("Google Drive metadata contract", () => {
  it("validates exact scope separation and rejects unauthorized scopes", () => {
    assert.equal(validateDriveScope([DRIVE_METADATA_READONLY_SCOPE]), true);
    assert.equal(validateDriveScope(["https://www.googleapis.com/auth/drive.readonly"]), false);
    assert.equal(validateDriveScope(["https://www.googleapis.com/auth/drive"]), false);
    assert.equal(validateDriveScope([]), false);
  });

  it("computes a deterministic canonical metadata hash", () => {
    const hash1 = computeMetadataHash({
      driveAccountId: "acc-123",
      sourceFolderId: "folder-456",
      driveFileId: "file-789",
      name: "Guia_Solidos.pdf",
      mimeType: "application/pdf",
      modifiedTime: "2026-09-10T12:00:00.000Z",
      size: 1048576,
      webViewLink: "https://drive.google.com/file/d/file-789/view",
    });
    const hash2 = computeMetadataHash({
      driveAccountId: "acc-123",
      sourceFolderId: "folder-456",
      driveFileId: "file-789",
      name: "Guia_Solidos.pdf",
      mimeType: "application/pdf",
      modifiedTime: "2026-09-10T12:00:00.000Z",
      size: 1048576,
      webViewLink: "https://drive.google.com/file/d/file-789/view",
    });
    assert.equal(typeof hash1, "string");
    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);

    const hashDifferent = computeMetadataHash({
      driveAccountId: "acc-123",
      sourceFolderId: "folder-456",
      driveFileId: "file-789",
      name: "Guia_Solidos_v2.pdf",
      mimeType: "application/pdf",
      modifiedTime: "2026-09-10T12:00:00.000Z",
      size: 1048576,
      webViewLink: "https://drive.google.com/file/d/file-789/view",
    });
    assert.notEqual(hash1, hashDifferent);
  });

  it("normalizes a valid raw file and rejects files not in allowlisted parent folder", () => {
    const raw: GoogleDriveFileWire = {
      id: "file-101",
      name: "Formulas_Termodinamica.pdf",
      mimeType: "application/pdf",
      parents: ["folder-materiales"],
      modifiedTime: "2026-09-01T08:00:00.000Z",
      size: "204800",
      webViewLink: "https://drive.google.com/file/d/file-101/view?usp=drivesdk",
      md5Checksum: "abcdef0123456789abcdef0123456789",
    };

    const normalized = normalizeDriveFile("acc-alex", "folder-materiales", raw);
    assert.equal(normalized.driveAccountId, "acc-alex");
    assert.equal(normalized.sourceFolderId, "folder-materiales");
    assert.equal(normalized.driveFileId, "file-101");
    assert.equal(normalized.name, "Formulas_Termodinamica.pdf");
    assert.equal(normalized.size, 204800);
    assert.equal(normalized.webViewLink, "https://drive.google.com/file/d/file-101/view?usp=drivesdk");
    assert.equal(normalized.providerChecksum, "abcdef0123456789abcdef0123456789");
    assert.equal(normalized.state, "active");

    assert.throws(
      () => normalizeDriveFile("acc-alex", "folder-materiales", { ...raw, parents: ["other-folder"] }),
      /File file-101 is not inside the allowlisted folder folder-materiales/i,
    );

    assert.throws(
      () => normalizeDriveFile("acc-alex", "folder-materiales", { ...raw, parents: [] }),
      /File file-101 is not inside the allowlisted folder folder-materiales/i,
    );
  });

  it("handles optional size and webViewLink for Google Docs/Sheets without errors", () => {
    const rawDoc: GoogleDriveFileWire = {
      id: "doc-202",
      name: "Apuntes Dinamica",
      mimeType: "application/vnd.google-apps.document",
      parents: ["folder-materiales"],
      modifiedTime: "2026-09-05T15:30:00.000Z",
    };

    const normalized = normalizeDriveFile("acc-alex", "folder-materiales", rawDoc);
    assert.equal(normalized.size, null);
    assert.equal(normalized.webViewLink, null);
    assert.equal(normalized.providerChecksum, null);
    assert.equal(normalized.state, "active");
  });
});
