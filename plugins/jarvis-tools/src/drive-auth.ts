import { validateDriveScope } from "./drive-contract.js";

export interface GoogleDriveOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class DriveAuthUnavailableError extends Error {
  constructor(message = "Google Drive authentication is unavailable.") {
    super(message);
    this.name = "DriveAuthUnavailableError";
  }
}

export class GoogleDriveOAuthTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly loadConfig: () => Promise<GoogleDriveOAuthCredentials>,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) {
      return this.cached.token;
    }
    try {
      const config = await this.loadConfig();
      if (!config.clientId || !config.clientSecret || !config.refreshToken) {
        throw new Error("missing Drive OAuth credentials");
      }
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      });
      const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) {
        throw new Error(`refresh rejected status=${response.status}`);
      }
      const payload = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
      };
      if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
        throw new Error("invalid refresh response");
      }

      if (typeof payload.scope === "string") {
        const scopes = payload.scope.split(" ");
        if (!validateDriveScope(scopes)) {
          throw new Error("Token response contains unauthorized wide scopes");
        }
      }

      this.cached = {
        token: payload.access_token,
        expiresAt: this.now() + Math.max(0, payload.expires_in) * 1000,
      };
      return this.cached.token;
    } catch (error) {
      this.cached = undefined;
      if (error instanceof Error && error.message.includes("unauthorized wide scopes")) {
        throw new DriveAuthUnavailableError("Unauthorized scope detected in Drive token response.");
      }
      throw new DriveAuthUnavailableError();
    }
  }
}
