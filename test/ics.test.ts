import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importAcademicIcs } from "../plugins/jarvis-tools/src/ics.js";

const fixture = `BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:America/Bogota\r\nBEGIN:VEVENT\r\nUID:alex-1@example\r\nDTSTART;TZID=America/Bogota:20260907T080000\r\nDTEND;TZID=America/Bogota:20260907T100000\r\nSUMMARY:Ecuaciones Diferenciales · Alex\r\nCATEGORIES:Alex\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:matthew-1@example\r\nDTSTART;TZID=America/Bogota:20260907T140000\r\nDTEND;TZID=America/Bogota:20260907T160000\r\nSUMMARY:Modelamiento · Matthew\r\nCATEGORIES:Matthew\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:alex-out@example\r\nDTSTART;TZID=America/Bogota:20261201T080000\r\nDTEND;TZID=America/Bogota:20261201T100000\r\nSUMMARY:Evento tardío · Alex\r\nCATEGORIES:Alex\r\nEND:VEVENT\r\nEND:VCALENDAR`;

describe("academic ICS import", () => {
  it("filters Alex events, preserves UID, and rejects events beyond the term", () => {
    const result = importAcademicIcs(fixture, {
      category: "Alex",
      timeZone: "America/Bogota",
      termStart: "2026-08-03",
      termEnd: "2026-11-20",
    });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0]?.uid, "alex-1@example");
    assert.equal(result.accepted[0]?.start, "2026-09-07T08:00:00-05:00");
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, "outside_academic_term");
    assert.equal(result.ignoredCategoryCount, 1);
  });

  it("fails closed when an event uses an unexpected timezone", () => {
    const unsafe = fixture.replace("DTSTART;TZID=America/Bogota:20260907T080000", "DTSTART;TZID=America/New_York:20260907T080000");
    assert.throws(() => importAcademicIcs(unsafe, {
      category: "Alex",
      timeZone: "America/Bogota",
      termStart: "2026-08-03",
      termEnd: "2026-11-20",
    }), /timezone/i);
  });
});