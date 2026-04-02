import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CalendarBackend, CalendarEvent } from "../types.js";
import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toolEnabled,
} from "./helpers.js";

function toLeanEvents(
  events: CalendarEvent[],
  opts: { includeCalendar: boolean }
) {
  return events.map(({ id, href, title, start, end, location, calendar, allDay }) => {
    const lean: Record<string, unknown> = { id, href, title, start, end, allDay };
    if (location) lean.location = location;
    if (opts.includeCalendar) lean.calendar = calendar;
    return lean;
  });
}

export function registerCalendarTools(
  server: McpServer,
  backend: CalendarBackend
): void {
  const disabled = parseDisabledTools();
  const defaultCalendar = process.env.CALDAV_DEFAULT_CALENDAR?.trim() || undefined;

  if (toolEnabled("list_calendars", disabled)) {
    server.tool(
      "list_calendars",
      "List all calendars",
      {},
      async () => {
        try {
          const calendars = await backend.listCalendars();
          return jsonResult(calendars);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("list_events", disabled)) {
    server.tool(
      "list_events",
      "List calendar events",
      {
        calendar: z
          .string()
          .optional()
          .describe("Calendar name to filter by"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max events to return (default 50)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields (description, organizer, attendees, recurrence, status) — default returns only id, href, title, start, end, location, calendar, allDay"
          ),
      },
      async ({ calendar, limit, verbose }) => {
        try {
          const cal = calendar ?? defaultCalendar;
          const events = await backend.listEvents({ calendar: cal, limit });
          if (verbose) return jsonResult(events);
          return jsonResult(toLeanEvents(events, { includeCalendar: !cal }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("get_event", disabled)) {
    server.tool(
      "get_event",
      "Get a single calendar event by href",
      {
        href: z
          .string()
          .describe("The event href (from list_events or search_events)"),
      },
      async ({ href }) => {
        try {
          const event = await backend.getEvent(href);
          if (!event) {
            return {
              content: [{ type: "text" as const, text: "Event not found" }],
              isError: true,
            };
          }
          return jsonResult(event);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("search_events", disabled)) {
    server.tool(
      "search_events",
      "Search calendar events by text query",
      {
        query: z.string().describe("Search text (matches title, description, location)"),
        calendar: z.string().optional().describe("Calendar name to search within"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results (default 50)"),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "Return all fields (description, organizer, attendees, recurrence, status) — default returns only id, href, title, start, end, location, calendar, allDay"
          ),
      },
      async ({ query, calendar, limit, verbose }) => {
        try {
          const cal = calendar ?? defaultCalendar;
          const events = await backend.searchEvents({ query, calendar: cal, limit });
          if (verbose) return jsonResult(events);
          return jsonResult(toLeanEvents(events, { includeCalendar: !cal }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
