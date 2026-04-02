import { CalDavBackend, CalDavConfig } from "./backend";
import { WebDavClient } from "../webdav/client";
import { DavResponseEntry } from "../webdav/xml";

jest.mock("../webdav/client");

const MockWebDavClient = WebDavClient as jest.MockedClass<typeof WebDavClient>;

// --- Test fixtures ---

const ICAL_STANDUP = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-1@example.com
SUMMARY:Team Standup
DTSTART:20250401T090000Z
DTEND:20250401T093000Z
LOCATION:Zoom
ORGANIZER;CN=Alice:mailto:alice@example.com
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

const ICAL_LUNCH = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-2@example.com
SUMMARY:Lunch with Bob
DTSTART:20250401T120000Z
DTEND:20250401T130000Z
LOCATION:Downtown Cafe
DESCRIPTION:Discuss project roadmap
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

const ICAL_ALLDAY = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-3@example.com
SUMMARY:Company Holiday
DTSTART;VALUE=DATE:20250401
DTEND;VALUE=DATE:20250402
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

// --- Helper to build DavResponseEntry ---

function entry(href: string, props: Record<string, string>): DavResponseEntry {
  return { href, props: new Map(Object.entries(props)) };
}

// --- Shared setup ---

function createBackend(): { backend: CalDavBackend; mockClient: jest.Mocked<WebDavClient> } {
  MockWebDavClient.mockClear();

  const config: CalDavConfig = {
    url: "https://caldav.example.com/dav",
    username: "user",
    password: "pass",
  };

  const backend = new CalDavBackend(config);
  const mockClient = MockWebDavClient.mock.instances[0] as jest.Mocked<WebDavClient>;

  return { backend, mockClient };
}

function setupDiscoveryMock(mockClient: jest.Mocked<WebDavClient>): void {
  // Step 1: current-user-principal
  mockClient.propfind.mockResolvedValueOnce([
    entry("https://caldav.example.com/dav", {
      "current-user-principal": '<d:href>/principals/user</d:href>',
    }),
  ]);

  // Step 2: calendar-home-set
  mockClient.propfind.mockResolvedValueOnce([
    entry("/principals/user", {
      "calendar-home-set": '<d:href>/calendars/user/</d:href>',
    }),
  ]);

  // Step 3: list calendars
  mockClient.propfind.mockResolvedValueOnce([
    entry("/calendars/user/", {
      resourcetype: '<d:collection/>',
    }),
    entry("/calendars/user/personal/", {
      resourcetype: '<d:collection/><c:calendar/>',
      displayname: "Personal",
      "calendar-color": "#FF0000",
      "calendar-description": "My personal calendar",
    }),
    entry("/calendars/user/work/", {
      resourcetype: '<d:collection/><c:calendar/>',
      displayname: "Work",
      "calendar-color": "#0000FF",
    }),
  ]);
}

describe("CalDavBackend", () => {
  describe("connect()", () => {
    it("discovers calendars via principal and calendar-home-set", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);

      await backend.connect();

      // Verify 3 PROPFIND calls
      expect(mockClient.propfind).toHaveBeenCalledTimes(3);

      // Step 1: principal discovery
      expect(mockClient.propfind).toHaveBeenNthCalledWith(
        1,
        "https://caldav.example.com/dav",
        expect.stringContaining("current-user-principal"),
        "0",
      );

      // Step 2: calendar-home-set
      expect(mockClient.propfind).toHaveBeenNthCalledWith(
        2,
        "/principals/user",
        expect.stringContaining("calendar-home-set"),
        "0",
      );

      // Step 3: calendar listing
      expect(mockClient.propfind).toHaveBeenNthCalledWith(
        3,
        "/calendars/user/",
        expect.stringContaining("resourcetype"),
        "1",
      );

      const calendars = await backend.listCalendars();
      expect(calendars).toHaveLength(2);
      expect(calendars[0]).toEqual({
        href: "/calendars/user/personal/",
        name: "Personal",
        color: "#FF0000",
        description: "My personal calendar",
      });
      expect(calendars[1]).toEqual({
        href: "/calendars/user/work/",
        name: "Work",
        color: "#0000FF",
        description: undefined,
      });
    });

    it("falls back to config.url as calendar-home when principal discovery fails", async () => {
      const { backend, mockClient } = createBackend();

      // Step 1 fails (direct URL)
      mockClient.propfind.mockRejectedValueOnce(new Error("Not found"));

      // Step 1 fails again (.well-known/caldav attempt)
      mockClient.propfind.mockRejectedValueOnce(new Error("Not found"));

      // Final fallback: list calendars directly from config.url
      mockClient.propfind.mockResolvedValueOnce([
        entry("/dav/", {
          resourcetype: '<d:collection/>',
        }),
        entry("/dav/my-cal/", {
          resourcetype: '<d:collection/><c:calendar/>',
          displayname: "My Calendar",
        }),
      ]);

      await backend.connect();

      const calendars = await backend.listCalendars();
      expect(calendars).toHaveLength(1);
      expect(calendars[0].name).toBe("My Calendar");
    });
  });

  describe("listCalendars()", () => {
    it("returns discovered calendars", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      const calendars = await backend.listCalendars();
      expect(calendars).toHaveLength(2);
      expect(calendars.map((c) => c.name)).toEqual(["Personal", "Work"]);
    });
  });

  describe("listEvents()", () => {
    it("parses calendar-data from REPORT response", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      // REPORT for Personal calendar
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/event1.ics", {
          getetag: '"etag1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/event2.ics", {
          getetag: '"etag2"',
          "calendar-data": ICAL_LUNCH,
        }),
      ]);

      // REPORT for Work calendar
      mockClient.report.mockResolvedValueOnce([]);

      const events = await backend.listEvents();

      expect(events).toHaveLength(2);
      // Sorted by start descending — Lunch (12:00) before Standup (09:00)
      expect(events[0].title).toBe("Lunch with Bob");
      expect(events[0].id).toBe("test-2@example.com");
      expect(events[0].calendar).toBe("Personal");
      expect(events[0].start).toBe("2025-04-01T12:00:00Z");
      expect(events[0].end).toBe("2025-04-01T13:00:00Z");
      expect(events[0].location).toBe("Downtown Cafe");
      expect(events[0].description).toBe("Discuss project roadmap");
      expect(events[0].allDay).toBe(false);

      expect(events[1].title).toBe("Team Standup");
      expect(events[1].id).toBe("test-1@example.com");
      expect(events[1].location).toBe("Zoom");
      expect(events[1].organizer).toBe("Alice");
      expect(events[1].status).toBe("CONFIRMED");
    });

    it("filters by calendar name", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      // Only Work calendar should be queried
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/work/event3.ics", {
          getetag: '"etag3"',
          "calendar-data": ICAL_STANDUP,
        }),
      ]);

      const events = await backend.listEvents({ calendar: "Work" });

      expect(mockClient.report).toHaveBeenCalledTimes(1);
      expect(mockClient.report).toHaveBeenCalledWith(
        "/calendars/user/work/",
        expect.stringContaining("calendar-query"),
      );
      expect(events).toHaveLength(1);
      expect(events[0].calendar).toBe("Work");
    });

    it("respects limit option", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/e1.ics", {
          getetag: '"e1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/e2.ics", {
          getetag: '"e2"',
          "calendar-data": ICAL_LUNCH,
        }),
        entry("/calendars/user/personal/e3.ics", {
          getetag: '"e3"',
          "calendar-data": ICAL_ALLDAY,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      const events = await backend.listEvents({ limit: 2 });

      expect(events).toHaveLength(2);
    });
  });

  describe("getEvent()", () => {
    it("fetches and parses a single event", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.get.mockResolvedValueOnce(ICAL_STANDUP);

      const event = await backend.getEvent("/calendars/user/personal/event1.ics");

      expect(mockClient.get).toHaveBeenCalledWith("/calendars/user/personal/event1.ics");
      expect(event).not.toBeNull();
      expect(event!.id).toBe("test-1@example.com");
      expect(event!.title).toBe("Team Standup");
      expect(event!.start).toBe("2025-04-01T09:00:00Z");
      expect(event!.end).toBe("2025-04-01T09:30:00Z");
      expect(event!.location).toBe("Zoom");
      expect(event!.calendar).toBe("Personal");
    });

    it("returns null for a missing event", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.get.mockRejectedValueOnce(new Error("404 Not Found"));

      const event = await backend.getEvent("/calendars/user/personal/nonexistent.ics");

      expect(event).toBeNull();
    });
  });

  describe("searchEvents()", () => {
    it("filters events by query text", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/e1.ics", {
          getetag: '"e1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/e2.ics", {
          getetag: '"e2"',
          "calendar-data": ICAL_LUNCH,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      const results = await backend.searchEvents({ query: "standup" });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Team Standup");
    });

    it("matches across title, description, location, and organizer", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/e1.ics", {
          getetag: '"e1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/e2.ics", {
          getetag: '"e2"',
          "calendar-data": ICAL_LUNCH,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      // Match on location
      const byLocation = await backend.searchEvents({ query: "zoom" });
      expect(byLocation).toHaveLength(1);
      expect(byLocation[0].title).toBe("Team Standup");

      // Reset mocks for next search
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/e1.ics", {
          getetag: '"e1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/e2.ics", {
          getetag: '"e2"',
          "calendar-data": ICAL_LUNCH,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      // Match on description
      const byDesc = await backend.searchEvents({ query: "roadmap" });
      expect(byDesc).toHaveLength(1);
      expect(byDesc[0].title).toBe("Lunch with Bob");

      // Reset mocks for next search
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/e1.ics", {
          getetag: '"e1"',
          "calendar-data": ICAL_STANDUP,
        }),
        entry("/calendars/user/personal/e2.ics", {
          getetag: '"e2"',
          "calendar-data": ICAL_LUNCH,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      // Match on organizer
      const byOrganizer = await backend.searchEvents({ query: "alice" });
      expect(byOrganizer).toHaveLength(1);
      expect(byOrganizer[0].title).toBe("Team Standup");
    });
  });

  // --- Task methods ---

  const ICAL_TODO_GROCERIES = `BEGIN:VCALENDAR
BEGIN:VTODO
UID:todo-1@example.com
SUMMARY:Buy groceries
DUE:20250420T170000Z
STATUS:NEEDS-ACTION
PRIORITY:1
CATEGORIES:Shopping,Personal
END:VTODO
END:VCALENDAR`;

  const ICAL_TODO_TAXES = `BEGIN:VCALENDAR
BEGIN:VTODO
UID:todo-2@example.com
SUMMARY:File taxes
DUE:20250415T120000Z
STATUS:COMPLETED
COMPLETED:20250414T180000Z
PERCENT-COMPLETE:100
END:VTODO
END:VCALENDAR`;

  describe("listTasks()", () => {
    it("fetches and parses VTODOs from all calendars", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/todo1.ics", {
          getetag: '"etag1"',
          "calendar-data": ICAL_TODO_GROCERIES,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/work/todo2.ics", {
          getetag: '"etag2"',
          "calendar-data": ICAL_TODO_TAXES,
        }),
      ]);

      const tasks = await backend.listTasks();

      expect(tasks).toHaveLength(2);
      // Sorted by due ascending: taxes (Apr 15) before groceries (Apr 20)
      expect(tasks[0].title).toBe("File taxes");
      expect(tasks[0].id).toBe("todo-2@example.com");
      expect(tasks[0].status).toBe("COMPLETED");
      expect(tasks[0].calendar).toBe("Work");

      expect(tasks[1].title).toBe("Buy groceries");
      expect(tasks[1].priority).toBe(1);
      expect(tasks[1].categories).toEqual(["Shopping", "Personal"]);
    });

    it("filters by status", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/todo1.ics", {
          getetag: '"etag1"',
          "calendar-data": ICAL_TODO_GROCERIES,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/work/todo2.ics", {
          getetag: '"etag2"',
          "calendar-data": ICAL_TODO_TAXES,
        }),
      ]);

      const tasks = await backend.listTasks({ status: "NEEDS-ACTION" });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Buy groceries");
    });
  });

  describe("getTask()", () => {
    it("fetches and parses a single task", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.get.mockResolvedValueOnce(ICAL_TODO_GROCERIES);

      const task = await backend.getTask("/calendars/user/personal/todo1.ics");

      expect(task).not.toBeNull();
      expect(task!.id).toBe("todo-1@example.com");
      expect(task!.title).toBe("Buy groceries");
      expect(task!.due).toBe("2025-04-20T17:00:00Z");
      expect(task!.status).toBe("NEEDS-ACTION");
      expect(task!.calendar).toBe("Personal");
    });

    it("returns null for missing task", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.get.mockRejectedValueOnce(new Error("404"));

      const task = await backend.getTask("/calendars/user/personal/nope.ics");
      expect(task).toBeNull();
    });
  });

  describe("searchTasks()", () => {
    it("filters tasks by query text", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/todo1.ics", {
          getetag: '"etag1"',
          "calendar-data": ICAL_TODO_GROCERIES,
        }),
        entry("/calendars/user/personal/todo2.ics", {
          getetag: '"etag2"',
          "calendar-data": ICAL_TODO_TAXES,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      const results = await backend.searchTasks({ query: "groceries" });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Buy groceries");
    });

    it("matches on categories", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.report.mockResolvedValueOnce([
        entry("/calendars/user/personal/todo1.ics", {
          getetag: '"etag1"',
          "calendar-data": ICAL_TODO_GROCERIES,
        }),
      ]);
      mockClient.report.mockResolvedValueOnce([]);

      const results = await backend.searchTasks({ query: "shopping" });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Buy groceries");
    });
  });

  describe("createTask()", () => {
    it("PUTs a new VTODO and returns the task", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      mockClient.put = jest.fn().mockResolvedValue("");
      mockClient.get.mockResolvedValueOnce(ICAL_TODO_GROCERIES);

      const task = await backend.createTask({
        title: "Buy groceries",
        due: "2025-04-20T17:00:00Z",
        priority: 1,
      });

      expect(mockClient.put).toHaveBeenCalledTimes(1);
      const putArgs = (mockClient.put as jest.Mock).mock.calls[0];
      expect(putArgs[0]).toMatch(/\.ics$/);
      expect(putArgs[1]).toContain("BEGIN:VTODO");
      expect(putArgs[1]).toContain("SUMMARY:Buy groceries");
      expect(putArgs[2]).toEqual({ "If-None-Match": "*" });

      expect(task.title).toBe("Buy groceries");
    });
  });

  describe("updateTask()", () => {
    it("GETs existing, PUTs modified version", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      // GET existing
      mockClient.get.mockResolvedValueOnce(ICAL_TODO_GROCERIES);
      // PUT updated
      mockClient.put = jest.fn().mockResolvedValue("");
      // GET back
      mockClient.get.mockResolvedValueOnce(
        ICAL_TODO_GROCERIES.replace("NEEDS-ACTION", "IN-PROCESS"),
      );

      const task = await backend.updateTask({
        href: "/calendars/user/personal/todo1.ics",
        status: "IN-PROCESS",
      });

      expect(mockClient.put).toHaveBeenCalledTimes(1);
      const putArgs = (mockClient.put as jest.Mock).mock.calls[0];
      expect(putArgs[1]).toContain("STATUS:IN-PROCESS");
      expect(putArgs[2]).toEqual({ "If-Match": "*" });

      expect(task.status).toBe("IN-PROCESS");
    });
  });

  describe("completeTask()", () => {
    it("marks task as completed", async () => {
      const { backend, mockClient } = createBackend();
      setupDiscoveryMock(mockClient);
      await backend.connect();

      // GET existing
      mockClient.get.mockResolvedValueOnce(ICAL_TODO_GROCERIES);
      // PUT completed
      mockClient.put = jest.fn().mockResolvedValue("");
      // GET back
      mockClient.get.mockResolvedValueOnce(
        ICAL_TODO_GROCERIES
          .replace("NEEDS-ACTION", "COMPLETED")
          + "\nPERCENT-COMPLETE:100\nCOMPLETED:20250415T120000Z",
      );

      const task = await backend.completeTask("/calendars/user/personal/todo1.ics");

      expect(mockClient.put).toHaveBeenCalledTimes(1);
      const putArgs = (mockClient.put as jest.Mock).mock.calls[0];
      expect(putArgs[1]).toContain("STATUS:COMPLETED");
      expect(putArgs[1]).toContain("PERCENT-COMPLETE:100");
      expect(putArgs[1]).toContain("COMPLETED:");
    });
  });

  describe("supported-calendar-component-set", () => {
    it("parses component types from discovery", async () => {
      const { backend, mockClient } = createBackend();

      // Step 1: principal
      mockClient.propfind.mockResolvedValueOnce([
        entry("https://caldav.example.com/dav", {
          "current-user-principal": '<d:href>/principals/user</d:href>',
        }),
      ]);

      // Step 2: calendar-home-set
      mockClient.propfind.mockResolvedValueOnce([
        entry("/principals/user", {
          "calendar-home-set": '<d:href>/calendars/user/</d:href>',
        }),
      ]);

      // Step 3: calendars with component-set
      mockClient.propfind.mockResolvedValueOnce([
        entry("/calendars/user/events/", {
          resourcetype: '<d:collection/><c:calendar/>',
          displayname: "Events Only",
          "supported-calendar-component-set": '<c:comp name="VEVENT"/>',
        }),
        entry("/calendars/user/tasks/", {
          resourcetype: '<d:collection/><c:calendar/>',
          displayname: "Tasks Only",
          "supported-calendar-component-set": '<c:comp name="VTODO"/>',
        }),
        entry("/calendars/user/both/", {
          resourcetype: '<d:collection/><c:calendar/>',
          displayname: "Both",
          "supported-calendar-component-set": '<c:comp name="VEVENT"/><c:comp name="VTODO"/>',
        }),
      ]);

      await backend.connect();

      const calendars = await backend.listCalendars();
      expect(calendars).toHaveLength(3);
      expect(calendars[0].supportedComponents).toEqual(["VEVENT"]);
      expect(calendars[1].supportedComponents).toEqual(["VTODO"]);
      expect(calendars[2].supportedComponents).toEqual(["VEVENT", "VTODO"]);

      // listTasks should only query task-capable calendars
      mockClient.report.mockResolvedValueOnce([]); // Tasks Only
      mockClient.report.mockResolvedValueOnce([]); // Both

      await backend.listTasks();

      expect(mockClient.report).toHaveBeenCalledTimes(2);
      expect(mockClient.report).toHaveBeenCalledWith(
        "/calendars/user/tasks/",
        expect.stringContaining("VTODO"),
      );
      expect(mockClient.report).toHaveBeenCalledWith(
        "/calendars/user/both/",
        expect.stringContaining("VTODO"),
      );
    });
  });
});
