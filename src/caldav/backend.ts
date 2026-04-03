import {
  CalendarBackend,
  CalendarInfo,
  CalendarEvent,
  ListEventsOptions,
  SearchEventsOptions,
  TaskBackend,
  TaskInfo,
  ListTasksOptions,
  SearchTasksOptions,
  CreateTaskOptions,
  UpdateTaskOptions,
} from "../types.js";
import { WebDavClient } from "../webdav/client.js";
import { hasElement, extractText } from "../webdav/xml.js";
import { parseICalendar, parseVTodos, serializeVTodo, ParsedVEvent, ParsedVTodo } from "./parser.js";
import { randomUUID } from "node:crypto";

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
    <c:supported-calendar-component-set/>
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

const REPORT_TODOS = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

export class CalDavBackend implements CalendarBackend, TaskBackend {
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
      calendarHomeUrl = await this.discoverCalendarHome(this.config.url);
    } catch {
      // Try .well-known/caldav discovery (RFC 6764)
      try {
        const base = new URL(this.config.url);
        const wellKnownUrl = `${base.origin}/.well-known/caldav`;
        calendarHomeUrl = await this.discoverCalendarHome(wellKnownUrl);
      } catch {
        // Final fallback: treat config.url as the calendar-home URL directly
        calendarHomeUrl = this.config.url;
      }
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

      // Parse supported-calendar-component-set: <comp name="VEVENT"/> <comp name="VTODO"/>
      let supportedComponents: string[] | undefined;
      const compSetXml = entry.props.get("supported-calendar-component-set");
      if (compSetXml) {
        const compNames: string[] = [];
        const compRe = /name="([^"]+)"/gi;
        let m;
        while ((m = compRe.exec(compSetXml)) !== null) {
          compNames.push(m[1].toUpperCase());
        }
        if (compNames.length > 0) {
          supportedComponents = compNames;
        }
      }

      this.calendars.push({
        href: entry.href,
        name,
        color,
        description,
        supportedComponents,
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

  // --- Task methods ---

  async listTasks(options?: ListTasksOptions): Promise<TaskInfo[]> {
    const limit = options?.limit ?? 50;
    const calendarFilter = options?.calendar;
    const statusFilter = options?.status;

    const targetCalendars = this.getTaskCalendars(calendarFilter);
    const allTasks: TaskInfo[] = [];

    for (const cal of targetCalendars) {
      const entries = await this.client.report(cal.href, REPORT_TODOS);

      for (const entry of entries) {
        const icalData = entry.props.get("calendar-data");
        if (!icalData) continue;

        const vtodos = parseVTodos(icalData);
        for (const vtodo of vtodos) {
          allTasks.push(this.mapTask(vtodo, entry.href, cal.name));
        }
      }
    }

    // Filter by status
    const includeCompleted = options?.includeCompleted ?? false;
    const filtered = statusFilter
      ? allTasks.filter((t) => t.status === statusFilter)
      : includeCompleted
        ? allTasks
        : allTasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED");

    // Sort: incomplete tasks first, then by due date ascending (nulls last)
    const isDone = (s?: string) => s === "COMPLETED" || s === "CANCELLED";
    filtered.sort((a, b) => {
      const aDone = isDone(a.status) ? 1 : 0;
      const bDone = isDone(b.status) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    });

    return filtered.slice(0, limit);
  }

  async getTask(href: string): Promise<TaskInfo | null> {
    let icalData: string;
    try {
      icalData = await this.client.get(href);
    } catch {
      return null;
    }

    const vtodos = parseVTodos(icalData);
    if (vtodos.length === 0) return null;

    const calendarName = this.inferCalendarName(href);
    return this.mapTask(vtodos[0], href, calendarName);
  }

  async searchTasks(options: SearchTasksOptions): Promise<TaskInfo[]> {
    const limit = options.limit ?? 50;
    const query = options.query.toLowerCase();

    const tasks = await this.listTasks({
      calendar: options.calendar,
      limit: Number.MAX_SAFE_INTEGER,
    });

    const matched = tasks.filter((t) => {
      const fields = [
        t.title,
        t.description,
        ...(t.categories || []),
      ];
      return fields.some((f) => f && f.toLowerCase().includes(query));
    });

    return matched.slice(0, limit);
  }

  async createTask(options: CreateTaskOptions): Promise<TaskInfo> {
    const targetCalendars = this.getTaskCalendars(options.calendar);
    if (targetCalendars.length === 0) {
      throw new Error(
        options.calendar
          ? `No task-capable calendar found matching "${options.calendar}"`
          : "No task-capable calendars found",
      );
    }

    const cal = targetCalendars[0];
    const uid = `${randomUUID()}@better-email-mcp`;
    const href = `${cal.href.replace(/\/$/, "")}/${randomUUID()}.ics`;

    const ical = serializeVTodo(
      {
        title: options.title,
        description: options.description,
        due: options.due,
        priority: options.priority,
        categories: options.categories,
        status: options.status || "NEEDS-ACTION",
      },
      uid,
    );

    await this.client.put(href, ical, { "If-None-Match": "*" });

    // Fetch back the created task
    const task = await this.getTask(href);
    if (!task) {
      // Fallback: return from what we know
      return this.mapTask(
        { uid, summary: options.title, status: options.status || "NEEDS-ACTION", due: options.due, priority: options.priority, description: options.description, categories: options.categories },
        href,
        cal.name,
      );
    }
    return task;
  }

  async updateTask(options: UpdateTaskOptions): Promise<TaskInfo> {
    // Fetch existing
    const icalData = await this.client.get(options.href);
    const vtodos = parseVTodos(icalData);
    if (vtodos.length === 0) {
      throw new Error(`No VTODO found at ${options.href}`);
    }

    const existing = vtodos[0];

    const ical = serializeVTodo(
      {
        title: options.title ?? existing.summary,
        description: options.description !== undefined ? options.description : existing.description,
        due: options.due !== undefined ? options.due : existing.due,
        start: existing.dtstart,
        priority: options.priority !== undefined ? options.priority : existing.priority,
        categories: options.categories !== undefined ? options.categories : existing.categories,
        status: options.status ?? existing.status,
        percentComplete: options.percentComplete !== undefined ? options.percentComplete : existing.percentComplete,
        completed: existing.completed,
      },
      existing.uid,
    );

    await this.client.put(options.href, ical, { "If-Match": "*" });

    const task = await this.getTask(options.href);
    if (!task) {
      throw new Error(`Failed to fetch updated task at ${options.href}`);
    }
    return task;
  }

  async completeTask(href: string): Promise<TaskInfo> {
    const icalData = await this.client.get(href);
    const vtodos = parseVTodos(icalData);
    if (vtodos.length === 0) {
      throw new Error(`No VTODO found at ${href}`);
    }

    const existing = vtodos[0];
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const ical = serializeVTodo(
      {
        title: existing.summary,
        description: existing.description,
        due: existing.due,
        start: existing.dtstart,
        priority: existing.priority,
        categories: existing.categories,
        status: "COMPLETED",
        percentComplete: 100,
        completed: now,
      },
      existing.uid,
    );

    await this.client.put(href, ical, { "If-Match": "*" });

    const task = await this.getTask(href);
    if (!task) {
      throw new Error(`Failed to fetch completed task at ${href}`);
    }
    return task;
  }

  private async discoverCalendarHome(startUrl: string): Promise<string> {
    // Step 1: Discover current-user-principal
    const principalEntries = await this.client.propfind(
      startUrl,
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

    return homeUrl;
  }

  private mapTask(vtodo: ParsedVTodo, href: string, calendar: string): TaskInfo {
    return {
      id: vtodo.uid,
      href,
      calendar,
      title: vtodo.summary,
      ...(vtodo.status !== undefined && { status: vtodo.status }),
      ...(vtodo.priority !== undefined && { priority: vtodo.priority }),
      ...(vtodo.due !== undefined && { due: vtodo.due }),
      ...(vtodo.dtstart !== undefined && { start: vtodo.dtstart }),
      ...(vtodo.completed !== undefined && { completed: vtodo.completed }),
      ...(vtodo.percentComplete !== undefined && { percentComplete: vtodo.percentComplete }),
      ...(vtodo.description !== undefined && { description: vtodo.description }),
      ...(vtodo.categories !== undefined && { categories: vtodo.categories }),
      ...(vtodo.rrule !== undefined && { recurrence: vtodo.rrule }),
    };
  }

  private getTaskCalendars(calendarFilter?: string): CalendarInfo[] {
    const calendars = this.calendars.filter((c) => {
      // If supportedComponents is set, check for VTODO; otherwise assume supported
      if (c.supportedComponents) {
        return c.supportedComponents.includes("VTODO");
      }
      return true;
    });

    if (calendarFilter) {
      return calendars.filter((c) => c.name === calendarFilter);
    }
    return calendars;
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
