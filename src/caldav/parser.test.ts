import { parseICalendar, icalDateToISO, ParsedVEvent } from "../caldav/parser";

// ---------------------------------------------------------------------------
// Helper to build a minimal VCALENDAR wrapper around VEVENT lines
// ---------------------------------------------------------------------------
function wrapVEvent(...eventBodies: string[]): string {
  const events = eventBodies
    .map((body) => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`)
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//Test//EN\r\n${events}\r\nEND:VCALENDAR`;
}

// ---------------------------------------------------------------------------
// 1. Basic VEVENT parsing
// ---------------------------------------------------------------------------
describe("basic VEVENT parsing", () => {
  it("parses summary, uid, dates, and location", () => {
    const ical = wrapVEvent(
      [
        "UID:abc-123",
        "SUMMARY:Team standup",
        "DTSTART:20250415T090000Z",
        "DTEND:20250415T093000Z",
        "LOCATION:Room 42",
      ].join("\r\n"),
    );

    const events = parseICalendar(ical);
    expect(events).toHaveLength(1);

    const e = events[0];
    expect(e.uid).toBe("abc-123");
    expect(e.summary).toBe("Team standup");
    expect(e.dtstart).toBe("2025-04-15T09:00:00Z");
    expect(e.dtend).toBe("2025-04-15T09:30:00Z");
    expect(e.location).toBe("Room 42");
    expect(e.allDay).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. All-day events (VALUE=DATE)
// ---------------------------------------------------------------------------
describe("all-day events", () => {
  it("detects VALUE=DATE parameter", () => {
    const ical = wrapVEvent(
      [
        "UID:allday-1",
        "SUMMARY:Holiday",
        "DTSTART;VALUE=DATE:20250501",
        "DTEND;VALUE=DATE:20250502",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.allDay).toBe(true);
    expect(e.dtstart).toBe("2025-05-01");
    expect(e.dtend).toBe("2025-05-02");
  });

  it("detects all-day from 8-char date without VALUE=DATE", () => {
    const ical = wrapVEvent(
      [
        "UID:allday-2",
        "SUMMARY:Birthday",
        "DTSTART:20250601",
        "DTEND:20250602",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.allDay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-line unfolding
// ---------------------------------------------------------------------------
describe("line unfolding", () => {
  it("unfolds lines starting with a space", () => {
    const raw = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:fold-1",
      "SUMMARY:This is a very long summ",
      " ary that wraps",
      "DTSTART:20250415T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [e] = parseICalendar(raw);
    expect(e.summary).toBe("This is a very long summary that wraps");
  });

  it("unfolds lines starting with a tab", () => {
    const raw = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:fold-2",
      "SUMMARY:Tab",
      "\tcontinued",
      "DTSTART:20250415T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const [e] = parseICalendar(raw);
    expect(e.summary).toBe("Tabcontinued");
  });
});

// ---------------------------------------------------------------------------
// 4. Organizer / attendee extraction
// ---------------------------------------------------------------------------
describe("organizer and attendees", () => {
  it("extracts organizer CN", () => {
    const ical = wrapVEvent(
      [
        "UID:org-1",
        "SUMMARY:Meeting",
        "DTSTART:20250415T140000Z",
        'ORGANIZER;CN="Alice Smith":mailto:alice@example.com',
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.organizer).toBe("Alice Smith");
  });

  it("falls back to mailto for organizer", () => {
    const ical = wrapVEvent(
      [
        "UID:org-2",
        "SUMMARY:Meeting",
        "DTSTART:20250415T140000Z",
        "ORGANIZER:mailto:bob@example.com",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.organizer).toBe("bob@example.com");
  });

  it("extracts multiple attendees", () => {
    const ical = wrapVEvent(
      [
        "UID:att-1",
        "SUMMARY:Meeting",
        "DTSTART:20250415T140000Z",
        'ATTENDEE;CN="Alice":mailto:alice@example.com',
        "ATTENDEE;CN=Bob:mailto:bob@example.com",
        "ATTENDEE:mailto:charlie@example.com",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.attendees).toEqual(["Alice", "Bob", "charlie@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Text unescaping
// ---------------------------------------------------------------------------
describe("text unescaping", () => {
  it("unescapes \\n, \\,, \\;, and \\\\", () => {
    const ical = wrapVEvent(
      [
        "UID:esc-1",
        "SUMMARY:Hello\\, world",
        "DTSTART:20250415T100000Z",
        "DESCRIPTION:Line one\\nLine two\\; more\\\\end",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.summary).toBe("Hello, world");
    expect(e.description).toBe("Line one\nLine two; more\\end");
  });
});

// ---------------------------------------------------------------------------
// 6. RRULE preservation
// ---------------------------------------------------------------------------
describe("RRULE", () => {
  it("preserves raw RRULE value", () => {
    const ical = wrapVEvent(
      [
        "UID:rrule-1",
        "SUMMARY:Weekly",
        "DTSTART:20250415T090000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=10");
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple VEVENTs in one VCALENDAR
// ---------------------------------------------------------------------------
describe("multiple VEVENTs", () => {
  it("parses all events", () => {
    const ical = wrapVEvent(
      ["UID:m1", "SUMMARY:First", "DTSTART:20250415T090000Z"].join("\r\n"),
      ["UID:m2", "SUMMARY:Second", "DTSTART:20250416T100000Z"].join("\r\n"),
    );

    const events = parseICalendar(ical);
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("First");
    expect(events[1].summary).toBe("Second");
  });
});

// ---------------------------------------------------------------------------
// 8. DURATION → dtend computation
// ---------------------------------------------------------------------------
describe("DURATION to dtend", () => {
  it("computes dtend from PT1H duration", () => {
    const ical = wrapVEvent(
      [
        "UID:dur-1",
        "SUMMARY:One hour",
        "DTSTART:20250415T143000Z",
        "DURATION:PT1H",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe("2025-04-15T15:30:00Z");
  });

  it("computes dtend from PT30M duration", () => {
    const ical = wrapVEvent(
      [
        "UID:dur-2",
        "SUMMARY:Half hour",
        "DTSTART:20250415T143000Z",
        "DURATION:PT30M",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe("2025-04-15T15:00:00Z");
  });

  it("computes dtend from P1D duration", () => {
    const ical = wrapVEvent(
      [
        "UID:dur-3",
        "SUMMARY:All day",
        "DTSTART;VALUE=DATE:20250415",
        "DURATION:P1D",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe("2025-04-16");
    expect(e.allDay).toBe(true);
  });

  it("computes dtend from P1DT2H duration", () => {
    const ical = wrapVEvent(
      [
        "UID:dur-4",
        "SUMMARY:Overnight",
        "DTSTART:20250415T200000Z",
        "DURATION:P1DT2H",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe("2025-04-16T22:00:00Z");
  });

  it("computes dtend from PT1H30M duration", () => {
    const ical = wrapVEvent(
      [
        "UID:dur-5",
        "SUMMARY:Ninety min",
        "DTSTART:20250415T100000Z",
        "DURATION:PT1H30M",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe("2025-04-15T11:30:00Z");
  });

  it("sets dtend = dtstart when neither DTEND nor DURATION present", () => {
    const ical = wrapVEvent(
      ["UID:dur-6", "SUMMARY:No end", "DTSTART:20250415T100000Z"].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtend).toBe(e.dtstart);
  });
});

// ---------------------------------------------------------------------------
// 9. TZID in date conversion
// ---------------------------------------------------------------------------
describe("icalDateToISO", () => {
  it("converts date-only", () => {
    expect(icalDateToISO("20250415")).toBe("2025-04-15");
  });

  it("converts datetime without Z", () => {
    expect(icalDateToISO("20250415T143000")).toBe("2025-04-15T14:30:00");
  });

  it("converts datetime with Z", () => {
    expect(icalDateToISO("20250415T143000Z")).toBe("2025-04-15T14:30:00Z");
  });

  it("appends TZID when present", () => {
    expect(icalDateToISO("20250415T143000", "TZID=America/New_York")).toBe(
      "2025-04-15T14:30:00 [America/New_York]",
    );
  });

  it("does not append TZID for UTC dates", () => {
    expect(icalDateToISO("20250415T143000Z", "TZID=America/New_York")).toBe(
      "2025-04-15T14:30:00Z",
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("returns empty array for empty calendar", () => {
    expect(parseICalendar("")).toEqual([]);
  });

  it("returns empty array for calendar with no events", () => {
    const ical = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
    expect(parseICalendar(ical)).toEqual([]);
  });

  it("handles event with minimal fields", () => {
    const ical = wrapVEvent(
      ["UID:min-1", "SUMMARY:Bare", "DTSTART:20250415T100000Z"].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.uid).toBe("min-1");
    expect(e.summary).toBe("Bare");
    expect(e.location).toBeUndefined();
    expect(e.description).toBeUndefined();
    expect(e.organizer).toBeUndefined();
    expect(e.attendees).toBeUndefined();
    expect(e.status).toBeUndefined();
    expect(e.rrule).toBeUndefined();
  });

  it("handles DTSTART with TZID in full event", () => {
    const ical = wrapVEvent(
      [
        "UID:tz-1",
        "SUMMARY:Eastern time",
        "DTSTART;TZID=America/New_York:20250415T143000",
        "DTEND;TZID=America/New_York:20250415T153000",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.dtstart).toBe("2025-04-15T14:30:00 [America/New_York]");
    expect(e.dtend).toBe("2025-04-15T15:30:00 [America/New_York]");
    expect(e.allDay).toBe(false);
  });

  it("handles STATUS field", () => {
    const ical = wrapVEvent(
      [
        "UID:status-1",
        "SUMMARY:Confirmed",
        "DTSTART:20250415T100000Z",
        "STATUS:CONFIRMED",
      ].join("\r\n"),
    );

    const [e] = parseICalendar(ical);
    expect(e.status).toBe("CONFIRMED");
  });
});
