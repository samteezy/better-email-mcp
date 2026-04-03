import { CardDavBackend, CardDavConfig } from "./backend";
import { DavResponseEntry } from "../webdav/xml";

// --- Mock WebDavClient ---

jest.mock("../webdav/client", () => {
  const mockClient = {
    propfind: jest.fn(),
    report: jest.fn(),
    get: jest.fn(),
  };

  return {
    WebDavClient: jest.fn(() => mockClient),
    WebDavError: class WebDavError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(`WebDAV error [${status}]: ${message}`);
        this.name = "WebDavError";
        this.status = status;
      }
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock("../webdav/client") as any;

function resetMocks() {
  mockClient.propfind.mockReset();
  mockClient.report.mockReset();
  mockClient.get.mockReset();
}

// --- Test fixtures ---

const TEST_CONFIG: CardDavConfig = {
  url: "https://carddav.example.com/dav",
  username: "user@example.com",
  password: "secret",
};

function entry(href: string, props: Record<string, string>): DavResponseEntry {
  return { href, props: new Map(Object.entries(props)) };
}

const PRINCIPAL_RESPONSE: DavResponseEntry[] = [
  entry("/dav", {
    "current-user-principal": '<d:href>/principals/user@example.com</d:href>',
  }),
];

const HOME_SET_RESPONSE: DavResponseEntry[] = [
  entry("/principals/user@example.com", {
    "addressbook-home-set": '<d:href>/dav/addressbooks/user@example.com/</d:href>',
  }),
];

const ADDRESSBOOKS_RESPONSE: DavResponseEntry[] = [
  entry("/dav/addressbooks/user@example.com/", {
    resourcetype: '<d:collection/><card:addressbook/>',
    displayname: "Personal",
  }),
  entry("/dav/addressbooks/user@example.com/work/", {
    resourcetype: '<d:collection/><card:addressbook/>',
    displayname: "Work",
    "addressbook-description": "Work contacts",
  }),
  entry("/dav/addressbooks/user@example.com/", {
    resourcetype: '<d:collection/>',
    displayname: "Not an addressbook",
  }),
];

const VCARD_ALICE = `BEGIN:VCARD
VERSION:3.0
UID:contact-1@example.com
FN:Alice Johnson
EMAIL;TYPE=work:alice@example.com
TEL;TYPE=cell:+1-555-0100
ORG:Acme Corp
TITLE:Engineer
END:VCARD`;

const VCARD_BOB = `BEGIN:VCARD
VERSION:3.0
UID:contact-2@example.com
FN:Bob Smith
EMAIL;TYPE=home:bob@example.com
TEL;TYPE=work:+1-555-0200
ORG:Widgets Inc
TITLE:Manager
ADR;TYPE=work:;;123 Main St;Springfield;IL;62701;US
NOTE:Met at conference
END:VCARD`;

const VCARD_CHARLIE = `BEGIN:VCARD
VERSION:3.0
UID:contact-3@example.com
FN:Charlie Brown
EMAIL;TYPE=home:charlie@peanuts.com
TEL;TYPE=cell:+1-555-0300
END:VCARD`;

const CONTACTS_REPORT_PERSONAL: DavResponseEntry[] = [
  entry("/dav/addressbooks/user@example.com/alice.vcf", {
    getetag: '"etag-1"',
    "address-data": VCARD_ALICE,
  }),
  entry("/dav/addressbooks/user@example.com/bob.vcf", {
    getetag: '"etag-2"',
    "address-data": VCARD_BOB,
  }),
];

const CONTACTS_REPORT_WORK: DavResponseEntry[] = [
  entry("/dav/addressbooks/user@example.com/work/charlie.vcf", {
    getetag: '"etag-3"',
    "address-data": VCARD_CHARLIE,
  }),
];

// --- Helper ---

function setupDiscovery() {
  mockClient.propfind
    .mockResolvedValueOnce(PRINCIPAL_RESPONSE)
    .mockResolvedValueOnce(HOME_SET_RESPONSE)
    .mockResolvedValueOnce(ADDRESSBOOKS_RESPONSE);
}

// --- Tests ---

describe("CardDavBackend", () => {
  let backend: CardDavBackend;

  beforeEach(() => {
    resetMocks();
    backend = new CardDavBackend(TEST_CONFIG);
  });

  describe("connect()", () => {
    it("discovers address books via principal → home-set → propfind", async () => {
      setupDiscovery();

      await backend.connect();

      // Step 1: principal discovery
      expect(mockClient.propfind).toHaveBeenCalledWith(
        TEST_CONFIG.url,
        expect.stringContaining("current-user-principal"),
        "0"
      );
      // Step 2: addressbook-home-set
      expect(mockClient.propfind).toHaveBeenCalledWith(
        "/principals/user@example.com",
        expect.stringContaining("addressbook-home-set"),
        "0"
      );
      // Step 3: list address books
      expect(mockClient.propfind).toHaveBeenCalledWith(
        "/dav/addressbooks/user@example.com/",
        expect.stringContaining("resourcetype"),
        "1"
      );

      const books = await backend.listAddressBooks();
      expect(books).toHaveLength(2);
      expect(books[0]).toEqual({
        href: "/dav/addressbooks/user@example.com/",
        name: "Personal",
      });
      expect(books[1]).toEqual({
        href: "/dav/addressbooks/user@example.com/work/",
        name: "Work",
        description: "Work contacts",
      });
    });

    it("falls back to config.url when principal discovery fails", async () => {
      mockClient.propfind
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce(ADDRESSBOOKS_RESPONSE);

      await backend.connect();

      // Should have tried principal discovery first (failed), then fallback
      expect(mockClient.propfind).toHaveBeenCalledTimes(2);
      // Fallback call uses config.url directly
      expect(mockClient.propfind).toHaveBeenLastCalledWith(
        TEST_CONFIG.url,
        expect.stringContaining("resourcetype"),
        "1"
      );

      const books = await backend.listAddressBooks();
      expect(books).toHaveLength(2);
    });
  });

  describe("listAddressBooks()", () => {
    it("returns discovered address books", async () => {
      setupDiscovery();
      await backend.connect();

      const books = await backend.listAddressBooks();
      expect(books).toEqual([
        { href: "/dav/addressbooks/user@example.com/", name: "Personal" },
        { href: "/dav/addressbooks/user@example.com/work/", name: "Work", description: "Work contacts" },
      ]);
    });
  });

  describe("listContacts()", () => {
    beforeEach(async () => {
      setupDiscovery();
      await backend.connect();
    });

    it("parses address-data from REPORT response", async () => {
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      const contacts = await backend.listContacts();

      expect(contacts).toHaveLength(3);
      // Sorted alphabetically by name
      expect(contacts[0].name).toBe("Alice Johnson");
      expect(contacts[1].name).toBe("Bob Smith");
      expect(contacts[2].name).toBe("Charlie Brown");

      // Check Alice's fields
      expect(contacts[0]).toMatchObject({
        id: "contact-1@example.com",
        href: "/dav/addressbooks/user@example.com/alice.vcf",
        addressBook: "Personal",
        name: "Alice Johnson",
        emails: ["alice@example.com"],
        phones: ["+1-555-0100"],
        organization: "Acme Corp",
        title: "Engineer",
      });

      // Check Bob has address and notes
      expect(contacts[1].address).toBe("123 Main St, Springfield, IL, 62701, US");
      expect(contacts[1].notes).toBe("Met at conference");

      // Charlie has no org/title — those fields should be absent
      expect(contacts[2].organization).toBeUndefined();
      expect(contacts[2].title).toBeUndefined();
    });

    it("filters by addressBook name", async () => {
      mockClient.report.mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      const contacts = await backend.listContacts({ addressBook: "Work" });

      expect(contacts).toHaveLength(1);
      expect(contacts[0].name).toBe("Charlie Brown");
      expect(mockClient.report).toHaveBeenCalledTimes(1);
      expect(mockClient.report).toHaveBeenCalledWith(
        "/dav/addressbooks/user@example.com/work/",
        expect.stringContaining("addressbook-query")
      );
    });

    it("applies limit", async () => {
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      const contacts = await backend.listContacts({ limit: 2 });

      expect(contacts).toHaveLength(2);
      // First two alphabetically
      expect(contacts[0].name).toBe("Alice Johnson");
      expect(contacts[1].name).toBe("Bob Smith");
    });
  });

  describe("getContact()", () => {
    beforeEach(async () => {
      setupDiscovery();
      await backend.connect();
    });

    it("fetches and parses a single contact", async () => {
      mockClient.get.mockResolvedValueOnce(VCARD_ALICE);

      const contact = await backend.getContact("/dav/addressbooks/user@example.com/alice.vcf");

      expect(contact).not.toBeNull();
      expect(contact!.id).toBe("contact-1@example.com");
      expect(contact!.name).toBe("Alice Johnson");
      expect(contact!.emails).toEqual(["alice@example.com"]);
      expect(contact!.phones).toEqual(["+1-555-0100"]);
      expect(contact!.organization).toBe("Acme Corp");
      expect(contact!.title).toBe("Engineer");
      expect(contact!.addressBook).toBe("Personal");
      expect(mockClient.get).toHaveBeenCalledWith("/dav/addressbooks/user@example.com/alice.vcf");
    });

    it("returns null for missing contact", async () => {
      mockClient.get.mockRejectedValueOnce(new Error("Not found"));

      const contact = await backend.getContact("/dav/addressbooks/user@example.com/nonexistent.vcf");

      expect(contact).toBeNull();
    });
  });

  describe("searchContacts()", () => {
    beforeEach(async () => {
      setupDiscovery();
      await backend.connect();
    });

    it("filters contacts by query text", async () => {
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      const results = await backend.searchContacts({ query: "alice" });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice Johnson");
    });

    it("matches across name, email, phone, and org", async () => {
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      // Search by org name
      let results = await backend.searchContacts({ query: "Acme" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice Johnson");

      // Search by email domain
      resetMocks();
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      results = await backend.searchContacts({ query: "peanuts.com" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Charlie Brown");

      // Search by phone
      resetMocks();
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      results = await backend.searchContacts({ query: "555-0200" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Bob Smith");

      // Search by title
      resetMocks();
      mockClient.report
        .mockResolvedValueOnce(CONTACTS_REPORT_PERSONAL)
        .mockResolvedValueOnce(CONTACTS_REPORT_WORK);

      results = await backend.searchContacts({ query: "Manager" });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Bob Smith");
    });
  });
});
