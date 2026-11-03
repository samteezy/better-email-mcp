import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CalendarBackend, CalendarEvent } from "../types.js";
import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toLean,
  toolEnabled,
} from "./helpers.js";

function toLeanEvents(
  events: CalendarEvent[],
  opts: { includeCalendar: boolean }
) {
  const always: (keyof CalendarEvent)[] = ["id", "href", "title", "start", "end", "allDay"];
  if (opts.includeCalendar) always.push("calendar");
  return toLean(events, always, ["location"]);
}

export function registerCalendarTools(
  server: McpServer,
  backend: CalendarBackend
): void {
  const disabled = parseDisabledTools();
  const defaultCalendar = process.env.CALDAV_DEFAULT_CALENDAR?.trim() || undefined;

  if (toolEnabled("list_calendars", disabled)) {
    server.registerTool(
      "list_calendars",
      { annotations: { readOnlyHint: true, openWorldHint: false }, description: "List all calendars", inputSchema: z.object({}) },
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
    server.registerTool(
      "list_events",
      { annotations: { readOnlyHint: true, openWorldHint: false }, description: "List calendar events", inputSchema: z.object({
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
      }) },
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
    server.registerTool(
      "get_event",
      { annotations: { readOnlyHint: true, openWorldHint: false }, description: "Get a single calendar event by href", inputSchema: z.object({
        href: z
          .string()
          .describe("The event href (from list_events or search_events)"),
      }) },
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
    server.registerTool(
      "search_events",
      { annotations: { readOnlyHint: true, openWorldHint: false }, description: "Search calendar events by text query", inputSchema: z.object({
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
      }) },
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
