import { readFile } from "node:fs/promises";
import { GoogleCalendarRestClient, GoogleOAuthTokenProvider } from "./calendar.js";

const clientIdFile = process.env.GOOGLE_CLIENT_ID_FILE;
const clientSecretFile = process.env.GOOGLE_CLIENT_SECRET_FILE;
const refreshTokenFile = process.env.GOOGLE_REFRESH_TOKEN_FILE;
const primaryCalendarId = process.env.GOOGLE_PRIMARY_CALENDAR_ID;
const managedCalendarId = process.env.GOOGLE_MANAGED_CALENDAR_ID;
if (!clientIdFile || !clientSecretFile || !refreshTokenFile || !primaryCalendarId || !managedCalendarId) throw new Error("Calendar readiness environment is incomplete.");
if (primaryCalendarId === managedCalendarId) throw new Error("Primary and managed calendar IDs must differ.");

const provider = new GoogleOAuthTokenProvider(async () => {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    readFile(clientIdFile, "utf8"), readFile(clientSecretFile, "utf8"), readFile(refreshTokenFile, "utf8"),
  ]);
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() };
});
const client = new GoogleCalendarRestClient(provider);
const start = new Date().toISOString();
const end = new Date(Date.now() + 60_000).toISOString();
process.stdout.write("GOOGLE_CALENDAR_READINESS_START checks=3\n");
try {
  await client.queryFreeBusy([primaryCalendarId, managedCalendarId], start, end);
  await client.listAgenda(primaryCalendarId, start, end, true);
  await client.listAgenda(managedCalendarId, start, end);
  process.stdout.write("GOOGLE_CALENDAR_READY checks=3 freebusy=ok primary_agenda=ok managed_agenda=ok\n");
} catch (error) {
  const code = error instanceof Error && error.name === "GoogleAuthUnavailableError" ? "auth_unavailable" : "calendar_api_unavailable";
  process.stderr.write(`GOOGLE_CALENDAR_READINESS_FAILURE code=${code}\n`);
  throw error;
}
