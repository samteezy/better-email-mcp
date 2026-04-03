import { extractText, extractAllText, hasElement, parseMultistatus } from "./xml";

describe("extractText()", () => {
  it("extracts text from a simple element", () => {
    expect(extractText("<href>/dav/cal</href>", "href")).toBe("/dav/cal");
  });

  it("extracts text from a namespaced element", () => {
    expect(extractText("<d:href>/dav/cal</d:href>", "href")).toBe("/dav/cal");
  });

  it("returns undefined when element is missing", () => {
    expect(extractText("<foo>bar</foo>", "baz")).toBeUndefined();
  });

  it("trims whitespace from content", () => {
    expect(extractText("<href>  /dav/cal  </href>", "href")).toBe("/dav/cal");
  });

  it("handles nested content (returns inner XML)", () => {
    const xml = "<prop><displayname>Work</displayname><color>#ff0000</color></prop>";
    const inner = extractText(xml, "prop");
    expect(inner).toContain("<displayname>Work</displayname>");
  });

  it("is case-insensitive on tag matching", () => {
    expect(extractText("<D:Href>/path</D:Href>", "Href")).toBe("/path");
  });
});

describe("extractAllText()", () => {
  it("extracts all matching elements", () => {
    const xml = "<d:href>/a</d:href><d:href>/b</d:href><d:href>/c</d:href>";
    expect(extractAllText(xml, "href")).toEqual(["/a", "/b", "/c"]);
  });

  it("returns empty array when no matches", () => {
    expect(extractAllText("<foo>bar</foo>", "baz")).toEqual([]);
  });

  it("handles mixed namespace prefixes", () => {
    const xml = "<d:status>HTTP/1.1 200 OK</d:status><D:status>HTTP/1.1 404 Not Found</D:status>";
    expect(extractAllText(xml, "status")).toEqual([
      "HTTP/1.1 200 OK",
      "HTTP/1.1 404 Not Found",
    ]);
  });
});

describe("hasElement()", () => {
  it("detects a self-closing element", () => {
    expect(hasElement("<d:collection/>", "collection")).toBe(true);
  });

  it("detects an element with content", () => {
    expect(hasElement("<d:collection>text</d:collection>", "collection")).toBe(true);
  });

  it("detects a namespaced self-closing element", () => {
    expect(hasElement('<cs:getctag xmlns:cs="foo"/>', "getctag")).toBe(true);
  });

  it("returns false when element is absent", () => {
    expect(hasElement("<d:href>/foo</d:href>", "collection")).toBe(false);
  });
});

describe("parseMultistatus()", () => {
  it("parses a single response with props", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/calendars/user/cal1/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Work</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].href).toBe("/dav/calendars/user/cal1/");
    expect(entries[0].props.get("displayname")).toBe("Work");
    expect(entries[0].props.has("resourcetype")).toBe(true);
    expect(entries[0].status).toBe("HTTP/1.1 200 OK");
  });

  it("parses multiple responses", () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/cal1/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Work</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal2/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Personal</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(2);
    expect(entries[0].props.get("displayname")).toBe("Work");
    expect(entries[1].props.get("displayname")).toBe("Personal");
  });

  it("filters out non-200 propstats", () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/cal1/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Work</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:calendar-color/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].props.get("displayname")).toBe("Work");
    expect(entries[0].props.has("calendar-color")).toBe(false);
  });

  it("handles different namespace prefixes", () => {
    const xml = `<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/contacts/</D:href>
    <D:propstat>
      <D:prop><D:displayname>Contacts</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].href).toBe("/contacts/");
    expect(entries[0].props.get("displayname")).toBe("Contacts");
  });

  it("handles self-closing prop elements (empty values)", () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Cal</d:displayname>
        <d:calendar-description/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries[0].props.get("calendar-description")).toBe("");
  });

  it("skips responses without href", () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:propstat>
      <d:prop><d:displayname>No href</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/valid/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Has href</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].href).toBe("/valid/");
  });

  it("preserves nested XML in prop values (calendar-data)", () => {
    const ical = "BEGIN:VCALENDAR\\nBEGIN:VEVENT\\nSUMMARY:Meeting\\nEND:VEVENT\\nEND:VCALENDAR";
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <cal:calendar-data>${ical}</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries[0].props.get("calendar-data")).toBe(ical);
  });

  it("returns empty array for empty multistatus", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"></d:multistatus>`;
    expect(parseMultistatus(xml)).toEqual([]);
  });

  it("returns empty array for non-XML input", () => {
    expect(parseMultistatus("not xml at all")).toEqual([]);
  });
});
