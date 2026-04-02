import { CalendarBackend, CalendarInfo, CalendarEvent, ListEventsOptions, SearchEventsOptions } from "../types.js";
import { WebDavClient } from "../webdav/client.js";
import { hasElement, extractText } from "../webdav/xml.js";
import { parseICalendar, ParsedVEvent } from "./parser.js";

export interface CalDavConfig {
  url: string;
  username: string;
  password: string;
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

const PROPFIND_CALENDAR_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <ic:calendar-color/>
    <c:calendar-description/>
  </d:prop>
</d:propfind>`;

const REPORT_EVENTS = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

export class CalDavBackend implements CalendarBackend {
  private client: WebDavClient;
  private config: CalDavConfig;
  private calendars: CalendarInfo[] = [];

  constructor(config: CalDavConfig) {
    this.config = config;
    this.client = new WebDavClient({
      baseUrl: config.url,
      username: config.username,
      password: config.password,
    });
  }

  async connect(): Promise<void> {
    let calendarHomeUrl: string;

    try {
      // Step 1: Discover current-user-principal
      const principalEntries = await this.client.propfind(
        this.config.url,
        PROPFIND_PRINCIPAL,
        "0",
      );

      let principalUrl: string | undefined;
      for (const entry of principalEntries) {
        const principalProp = entry.props.get("current-user-principal");
        if (principalProp) {
          principalUrl = extractText(principalProp, "href");
          break;
        }
      }

      if (!principalUrl) {
        throw new Error("No current-user-principal found");
      }

      // Step 2: Discover calendar-home-set
      const homeEntries = await this.client.propfind(
        principalUrl,
        PROPFIND_CALENDAR_HOME,
        "0",
      );

      let homeUrl: string | undefined;
      for (const entry of homeEntries) {
        const homeProp = entry.props.get("calendar-home-set");
        if (homeProp) {
          homeUrl = extractText(homeProp, "href");
          break;
        }
      }

      if (!homeUrl) {
        throw new Error("No calendar-home-set found");
      }

      calendarHomeUrl = homeUrl;
    } catch {
      // Fallback: treat config.url as the calendar-home URL directly
      calendarHomeUrl = this.config.url;
    }

    // Step 3: Discover calendars
    const calEntries = await this.client.propfind(
      calendarHomeUrl,
      PROPFIND_CALENDARS,
      "1",
    );

    this.calendars = [];
    for (const entry of calEntries) {
      const resourceType = entry.props.get("resourcetype");
      if (!resourceType || !hasElement(resourceType, "calendar")) {
        continue;
      }

      const name = entry.props.get("displayname") || entry.href;
      const color = entry.props.get("calendar-color") || undefined;
      const description = entry.props.get("calendar-description") || undefined;

      this.calendars.push({
        href: entry.href,
        name,
        color,
        description,
      });
    }
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.calendars;
  }

  async listEvents(options?: ListEventsOptions): Promise<CalendarEvent[]> {
    const limit = options?.limit ?? 50;
    const calendarFilter = options?.calendar;

    const targetCalendars = calendarFilter
      ? this.calendars.filter((c) => c.name === calendarFilter)
      : this.calendars;

    const allEvents: CalendarEvent[] = [];

    for (const cal of targetCalendars) {
      const entries = await this.client.report(cal.href, REPORT_EVENTS);

      for (const entry of entries) {
        const icalData = entry.props.get("calendar-data");
        if (!icalData) continue;

        const vevents = parseICalendar(icalData);
        for (const vevent of vevents) {
          allEvents.push(this.mapEvent(vevent, entry.href, cal.name));
        }
      }
    }

    // Sort by start descending
    allEvents.sort((a, b) => (a.start > b.start ? -1 : a.start < b.start ? 1 : 0));

    return allEvents.slice(0, limit);
  }

  async getEvent(href: string): Promise<CalendarEvent | null> {
    let icalData: string;
    try {
      icalData = await this.client.get(href);
    } catch {
      return null;
    }

    const vevents = parseICalendar(icalData);
    if (vevents.length === 0) return null;

    const calendarName = this.inferCalendarName(href);
    return this.mapEvent(vevents[0], href, calendarName);
  }

  async searchEvents(options: SearchEventsOptions): Promise<CalendarEvent[]> {
    const limit = options.limit ?? 50;
    const query = options.query.toLowerCase();

    // Fetch all events in scope
    const events = await this.listEvents({
      calendar: options.calendar,
      limit: Number.MAX_SAFE_INTEGER,
    });

    // Filter client-side
    const matched = events.filter((evt) => {
      const fields = [
        evt.title,
        evt.description,
        evt.location,
        evt.organizer,
      ];
      return fields.some((f) => f && f.toLowerCase().includes(query));
    });

    return matched.slice(0, limit);
  }

  private mapEvent(vevent: ParsedVEvent, href: string, calendar: string): CalendarEvent {
    return {
      id: vevent.uid,
      href,
      calendar,
      title: vevent.summary,
      start: vevent.dtstart,
      end: vevent.dtend,
      location: vevent.location,
      description: vevent.description,
      organizer: vevent.organizer,
      attendees: vevent.attendees,
      status: vevent.status,
      recurrence: vevent.rrule,
      allDay: vevent.allDay,
    };
  }

  private inferCalendarName(href: string): string {
    for (const cal of this.calendars) {
      if (href.startsWith(cal.href)) {
        return cal.name;
      }
    }
    return "Unknown";
  }
}
