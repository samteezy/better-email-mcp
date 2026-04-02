/**
 * iCalendar (RFC 5545) parser.
 *
 * Hand-written parser for VCALENDAR/VEVENT data. Handles line unfolding,
 * property parameter extraction, date/duration conversion, and text
 * unescaping. No external dependencies.
 */

// --- Types ---

export interface ParsedVEvent {
  uid: string;
  summary: string;
  dtstart: string;     // ISO 8601
  dtend: string;       // ISO 8601
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
  status?: string;
  rrule?: string;
  allDay: boolean;
}

// --- Date / Duration helpers ---

/**
 * Convert an iCalendar date or datetime value to ISO 8601.
 *
 *   20250415           → 2025-04-15
 *   20250415T143000    → 2025-04-15T14:30:00
 *   20250415T143000Z   → 2025-04-15T14:30:00Z
 *
 * If `params` contains a TZID, the timezone is appended in brackets:
 *   2025-04-15T14:30:00 [America/New_York]
 */
export function icalDateToISO(value: string, params?: string): string {
  const v = value.trim();

  // Extract TZID from params if present
  let tzid: string | undefined;
  if (params) {
    const m = params.match(/TZID=([^;:]+)/i);
    if (m) {
      tzid = m[1];
    }
  }

  // DATE only: YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }

  // DATETIME: YYYYMMDDTHHmmss[Z]
  const dtMatch = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dtMatch) {
    const [, y, mo, d, h, mi, s, z] = dtMatch;
    let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    if (z) {
      iso += "Z";
    } else if (tzid) {
      iso += ` [${tzid}]`;
    }
    return iso;
  }

  // Fallback: return as-is
  return v;
}

interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Parse an ISO 8601 duration string (subset used in iCalendar).
 * Supports: P1D, PT1H, PT30M, PT1H30M, P1DT2H, PT45S, etc.
 */
function parseDuration(dur: string): DurationParts {
  const parts: DurationParts = { days: 0, hours: 0, minutes: 0, seconds: 0 };
  const m = dur.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return parts;
  if (m[1]) parts.days = parseInt(m[1], 10);
  if (m[2]) parts.hours = parseInt(m[2], 10);
  if (m[3]) parts.minutes = parseInt(m[3], 10);
  if (m[4]) parts.seconds = parseInt(m[4], 10);
  return parts;
}

/**
 * Add a duration to an iCalendar date/datetime value and return the
 * result in ISO 8601 format.
 */
function addDuration(dtValue: string, duration: string, dtParams?: string): string {
  const dur = parseDuration(duration);
  const v = dtValue.trim();

  // Parse the date/datetime into a JS Date so we can do arithmetic.
  // DATE: YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    const d = new Date(
      Date.UTC(
        parseInt(v.slice(0, 4), 10),
        parseInt(v.slice(4, 6), 10) - 1,
        parseInt(v.slice(6, 8), 10),
      ),
    );
    d.setUTCDate(d.getUTCDate() + dur.days);
    d.setUTCHours(d.getUTCHours() + dur.hours);
    d.setUTCMinutes(d.getUTCMinutes() + dur.minutes);
    d.setUTCSeconds(d.getUTCSeconds() + dur.seconds);
    // If the original was a DATE, return date-only when duration is whole days
    if (dur.hours === 0 && dur.minutes === 0 && dur.seconds === 0) {
      const yy = String(d.getUTCFullYear()).padStart(4, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yy}-${mm}-${dd}`;
    }
    // Otherwise fall through to datetime formatting
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // DATETIME: YYYYMMDDTHHmmss[Z]
  const dtMatch = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dtMatch) {
    const [, y, mo, da, h, mi, s, z] = dtMatch;
    const d = new Date(
      Date.UTC(
        parseInt(y, 10),
        parseInt(mo, 10) - 1,
        parseInt(da, 10),
        parseInt(h, 10),
        parseInt(mi, 10),
        parseInt(s, 10),
      ),
    );
    d.setUTCDate(d.getUTCDate() + dur.days);
    d.setUTCHours(d.getUTCHours() + dur.hours);
    d.setUTCMinutes(d.getUTCMinutes() + dur.minutes);
    d.setUTCSeconds(d.getUTCSeconds() + dur.seconds);

    const ry = String(d.getUTCFullYear()).padStart(4, "0");
    const rmo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const rda = String(d.getUTCDate()).padStart(2, "0");
    const rh = String(d.getUTCHours()).padStart(2, "0");
    const rmi = String(d.getUTCMinutes()).padStart(2, "0");
    const rs = String(d.getUTCSeconds()).padStart(2, "0");

    let iso = `${ry}-${rmo}-${rda}T${rh}:${rmi}:${rs}`;
    if (z) {
      iso += "Z";
    } else {
      // Preserve TZID from params
      let tzid: string | undefined;
      if (dtParams) {
        const tm = dtParams.match(/TZID=([^;:]+)/i);
        if (tm) tzid = tm[1];
      }
      if (tzid) iso += ` [${tzid}]`;
    }
    return iso;
  }

  // Fallback
  return icalDateToISO(v, dtParams);
}

// --- Text helpers ---

/**
 * Unescape iCalendar text values per RFC 5545 §3.3.11.
 */
function unescapeText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n" || next === "N") {
        result += "\n";
        i++;
      } else if (next === ",") {
        result += ",";
        i++;
      } else if (next === ";") {
        result += ";";
        i++;
      } else if (next === "\\") {
        result += "\\";
        i++;
      } else {
        result += text[i];
      }
    } else {
      result += text[i];
    }
  }
  return result;
}

/**
 * Extract the CN parameter from a property's parameter string,
 * or fall back to stripping `mailto:` from the value.
 */
function extractPerson(params: string, value: string): string {
  // Try CN="Name" or CN=Name
  const cnQuoted = params.match(/CN="([^"]+)"/i);
  if (cnQuoted) return cnQuoted[1];
  const cnPlain = params.match(/CN=([^;:]+)/i);
  if (cnPlain) return cnPlain[1].trim();
  // Fall back to mailto:
  return value.replace(/^mailto:/i, "");
}

// --- Property parsing ---

interface ICalProperty {
  name: string;   // e.g. "DTSTART"
  params: string; // e.g. "TZID=America/New_York" (everything between name and ':')
  value: string;  // everything after ':'
}

/**
 * Parse a single unfolded iCal content line into name, params, and value.
 * The colon delimiter is the first `:` that is not inside double quotes.
 */
function parseProperty(line: string): ICalProperty | null {
  // Find the first colon not inside quotes
  let inQuotes = false;
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === ":" && !inQuotes) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx === -1) return null;

  const nameAndParams = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  // Split name from params on first semicolon (outside quotes)
  let semiIdx = -1;
  inQuotes = false;
  for (let i = 0; i < nameAndParams.length; i++) {
    if (nameAndParams[i] === '"') {
      inQuotes = !inQuotes;
    } else if (nameAndParams[i] === ";" && !inQuotes) {
      semiIdx = i;
      break;
    }
  }

  const name = semiIdx === -1 ? nameAndParams : nameAndParams.slice(0, semiIdx);
  const params = semiIdx === -1 ? "" : nameAndParams.slice(semiIdx + 1);

  return { name: name.toUpperCase(), params, value };
}

// --- Main parser ---

/**
 * Parse an iCalendar string and return all VEVENTs as structured objects.
 */
export function parseICalendar(ical: string): ParsedVEvent[] {
  // Step 1: Unfold continuation lines.
  // RFC 5545 §3.1 — a long line can be split by inserting CRLF + single whitespace.
  const unfolded = ical
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "");

  const lines = unfolded.split(/\r\n|\r|\n/);

  // Step 2: Extract VEVENT blocks.
  const events: ParsedVEvent[] = [];
  let inEvent = false;
  let eventLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      eventLines = [];
    } else if (trimmed === "END:VEVENT") {
      if (inEvent) {
        const evt = parseVEvent(eventLines);
        if (evt) events.push(evt);
      }
      inEvent = false;
    } else if (inEvent) {
      eventLines.push(line);
    }
  }

  return events;
}

/**
 * Parse lines from a single VEVENT block into a ParsedVEvent.
 */
function parseVEvent(lines: string[]): ParsedVEvent | null {
  let uid = "";
  let summary = "";
  let dtstart = "";
  let dtend = "";
  let location: string | undefined;
  let description: string | undefined;
  let organizer: string | undefined;
  let status: string | undefined;
  let rrule: string | undefined;
  let duration: string | undefined;
  const attendees: string[] = [];

  let dtstartRaw = "";
  let dtstartParams = "";
  let allDay = false;

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;

    switch (prop.name) {
      case "UID":
        uid = prop.value;
        break;
      case "SUMMARY":
        summary = unescapeText(prop.value);
        break;
      case "DTSTART":
        dtstartRaw = prop.value;
        dtstartParams = prop.params;
        allDay =
          /VALUE=DATE(?![-T])/i.test(prop.params) ||
          /^\d{8}$/.test(prop.value.trim());
        dtstart = icalDateToISO(prop.value, prop.params);
        break;
      case "DTEND":
        dtend = icalDateToISO(prop.value, prop.params);
        break;
      case "DURATION":
        duration = prop.value;
        break;
      case "LOCATION":
        location = unescapeText(prop.value);
        break;
      case "DESCRIPTION":
        description = unescapeText(prop.value);
        break;
      case "ORGANIZER":
        organizer = extractPerson(prop.params, prop.value);
        break;
      case "ATTENDEE":
        attendees.push(extractPerson(prop.params, prop.value));
        break;
      case "STATUS":
        status = prop.value;
        break;
      case "RRULE":
        rrule = prop.value;
        break;
    }
  }

  // Compute dtend from DURATION if DTEND not explicitly set
  if (!dtend && duration && dtstartRaw) {
    dtend = addDuration(dtstartRaw, duration, dtstartParams);
  }

  // Fallback: dtend = dtstart
  if (!dtend) {
    dtend = dtstart;
  }

  return {
    uid,
    summary,
    dtstart,
    dtend,
    ...(location !== undefined && { location }),
    ...(description !== undefined && { description }),
    ...(organizer !== undefined && { organizer }),
    ...(attendees.length > 0 && { attendees }),
    ...(status !== undefined && { status }),
    ...(rrule !== undefined && { rrule }),
    allDay,
  };
}
