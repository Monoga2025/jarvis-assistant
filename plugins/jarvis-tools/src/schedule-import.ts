import { readFile } from "node:fs/promises";
import { GoogleCalendarRestClient, GoogleOAuthTokenProvider, JarvisCalendarService } from "./calendar.js";
import { resolveImportIcs } from "./finance.js";
import { importAcademicIcs } from "./ics.js";

const databaseIndependentFile = process.env.JARVIS_SCHEDULE_ICS_FILE;
const importDirectory = process.env.JARVIS_IMPORT_DIRECTORY;
const clientIdFile = process.env.GOOGLE_CLIENT_ID_FILE;
const clientSecretFile = process.env.GOOGLE_CLIENT_SECRET_FILE;
const refreshTokenFile = process.env.GOOGLE_REFRESH_TOKEN_FILE;
const primaryCalendarId = process.env.GOOGLE_PRIMARY_CALENDAR_ID;
const managedCalendarId = process.env.GOOGLE_MANAGED_CALENDAR_ID;
if (!databaseIndependentFile || !importDirectory || !clientIdFile || !clientSecretFile || !refreshTokenFile || !primaryCalendarId || !managedCalendarId) {
  throw new Error("Schedule import environment is incomplete.");
}
const filePath = await resolveImportIcs(importDirectory, databaseIndependentFile);
const source = await readFile(filePath, "utf8");
const parsed = importAcademicIcs(source, { category: "Alex", timeZone: "America/Bogota", termStart: "2026-08-03", termEnd: "2026-11-20" });
const tokenProvider = new GoogleOAuthTokenProvider(async () => {
  const [clientId, clientSecret, refreshToken] = await Promise.all([readFile(clientIdFile, "utf8"), readFile(clientSecretFile, "utf8"), readFile(refreshTokenFile, "utf8")]);
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim(), refreshToken: refreshToken.trim() };
});
const service = new JarvisCalendarService(new GoogleCalendarRestClient(tokenProvider), { primaryCalendarId, managedCalendarId });
let persisted = 0;
for (const event of parsed.accepted) {
  await service.persistAcademicEvent(event);
  persisted += 1;
}
process.stdout.write(`SCHEDULE_IMPORT_READY accepted=${parsed.accepted.length} persisted=${persisted} rejected=${parsed.rejected.length}\n`);
