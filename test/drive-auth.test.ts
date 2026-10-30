import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GoogleDriveOAuthTokenProvider,
  DriveAuthUnavailableError,
} from "../plugins/jarvis-tools/src/drive-auth.js";
import { DRIVE_METADATA_READONLY_SCOPE } from "../plugins/jarvis-tools/src/drive-contract.js";

describe("Drive OAuth token provider", () => {
  it("exchanges valid refresh token and caches access token", async () => {
    let fetchCount = 0;
    const provider = new GoogleDriveOAuthTokenProvider(
      async () => ({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      }),
      async (_url, options) => {
        fetchCount += 1;
        assert.equal((options?.headers as Record<string, string>)?.["content-type"], "application/x-www-form-urlencoded");
        return new Response(JSON.stringify({
          access_token: "mock-access-token-123",
          expires_in: 3600,
          scope: DRIVE_METADATA_READONLY_SCOPE,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    const token1 = await provider.getAccessToken();
    assert.equal(token1, "mock-access-token-123");
    assert.equal(fetchCount, 1);

    // Second call should return cached token without fetching again
    const token2 = await provider.getAccessToken();
    assert.equal(token2, "mock-access-token-123");
    assert.equal(fetchCount, 1);
  });

  it("fails closed and throws DriveAuthUnavailableError when wide scope is returned", async () => {
    const provider = new GoogleDriveOAuthTokenProvider(
      async () => ({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      }),
      async () => new Response(JSON.stringify({
        access_token: "mock-access-token-wide",
        expires_in: 3600,
        scope: `${DRIVE_METADATA_READONLY_SCOPE} https://www.googleapis.com/auth/drive`,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    await assert.rejects(
      () => provider.getAccessToken(),
      (err: unknown) => err instanceof DriveAuthUnavailableError,
    );
  });

  it("fails closed when refresh token exchange is rejected with 401", async () => {
    const provider = new GoogleDriveOAuthTokenProvider(
      async () => ({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "invalid-token",
      }),
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    );

    await assert.rejects(
      () => provider.getAccessToken(),
      (err: unknown) => err instanceof DriveAuthUnavailableError,
    );
  });
});
