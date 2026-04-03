/**
 * Tests for JmapContactsBackend JSContact → Contact mapping.
 *
 * These test the mapping logic by exercising the backend methods with mocked
 * JMAP responses, since the mapping helpers are private.
 */

// Mock global fetch before importing the module
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { JmapContactsBackend } from "./jmap-contacts.js";
import { JmapBackend } from "./jmap.js";

function makeBackend(): JmapContactsBackend {
  const fakeJmapBackend = {
    getSession: () => ({
      apiUrl: "https://api.example.com/jmap",
      accountId: "account-1",
    }),
    jmapRequest: async (methodCalls: any[][], _using?: string[]) => {
      const res = await fetch("https://api.example.com/jmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ methodCalls }),
      });
      const data = await res.json();
      return data.methodResponses;
    },
    findResponse: (responses: any[][], methodName: string) => {
      for (const response of responses) {
        if (response[0] === methodName) return response[1];
      }
      throw new Error(`Expected ${methodName} response not found`);
    },
  } as unknown as JmapBackend;

  return new JmapContactsBackend(fakeJmapBackend);
}

function mockJmapResponse(...methodResponses: any[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ methodResponses }),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("connect", () => {
  it("fetches and caches address books", async () => {
    const backend = makeBackend();

    // connect() calls getSession internally
    mockFetch.mockReset();
    // Simulate the connect() call needing getSession, but we already injected it
    // The connect() method will call AddressBook/get
    mockJmapResponse([
      "AddressBook/get",
      {
        list: [
          { id: "ab-1", name: "Personal", description: "My contacts", isDefault: true },
          { id: "ab-2", name: "Work" },
        ],
      },
      "0",
    ]);

    await backend.connect();
    const books = await backend.listAddressBooks();
    expect(books).toEqual([
      { href: "ab-1", name: "Personal", description: "My contacts" },
      { href: "ab-2", name: "Work" },
    ]);
  });
});

describe("listContacts", () => {
  it("maps JSContact cards to Contact objects", async () => {
    const backend = makeBackend();

    // connect
    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    // listContacts
    mockJmapResponse(
      ["ContactCard/query", { ids: ["c-1", "c-2"] }, "0"],
      [
        "ContactCard/get",
        {
          list: [
            {
              id: "c-1",
              name: { full: "Alice Smith" },
              emails: { e1: { address: "alice@example.com" } },
              phones: { p1: { phone: "+1234567890" } },
              organizations: { o1: { name: "Acme Inc" } },
              titles: { t1: { name: "Engineer" } },
              addressBookIds: { "ab-1": true },
            },
            {
              id: "c-2",
              name: {
                components: [
                  { kind: "given", value: "Bob" },
                  { kind: "surname", value: "Jones" },
                ],
              },
              emails: {},
              phones: {},
              addressBookIds: { "ab-1": true },
            },
          ],
        },
        "1",
      ]
    );

    const contacts = await backend.listContacts();
    expect(contacts).toHaveLength(2);

    expect(contacts[0]).toEqual({
      id: "c-1",
      href: "c-1",
      addressBook: "Personal",
      name: "Alice Smith",
      emails: ["alice@example.com"],
      phones: ["+1234567890"],
      organization: "Acme Inc",
      title: "Engineer",
    });

    // Name assembled from components
    expect(contacts[1]).toEqual({
      id: "c-2",
      href: "c-2",
      addressBook: "Personal",
      name: "Bob Jones",
    });
  });

  it("filters by address book name", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      {
        list: [
          { id: "ab-1", name: "Personal" },
          { id: "ab-2", name: "Work" },
        ],
      },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse(
      ["ContactCard/query", { ids: ["c-1"] }, "0"],
      [
        "ContactCard/get",
        {
          list: [
            {
              id: "c-1",
              name: { full: "Work Contact" },
              addressBookIds: { "ab-2": true },
            },
          ],
        },
        "1",
      ]
    );

    const contacts = await backend.listContacts({ addressBook: "Work" });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].addressBook).toBe("Work");

    // Verify the filter was sent in the request
    const requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(requestBody.methodCalls[0][1].filter).toEqual({
      inAddressBook: "ab-2",
    });
  });
});

describe("getContact", () => {
  it("returns full contact with address and notes", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse([
      "ContactCard/get",
      {
        list: [
          {
            id: "c-1",
            name: { full: "Alice Smith" },
            emails: { e1: { address: "alice@example.com" } },
            phones: {},
            organizations: {},
            titles: {},
            addresses: {
              a1: {
                full: "123 Main St, Springfield, IL 62701",
              },
            },
            notes: {
              n1: { note: "Met at conference" },
            },
            addressBookIds: { "ab-1": true },
          },
        ],
        notFound: [],
      },
      "0",
    ]);

    const contact = await backend.getContact("c-1");
    expect(contact).toEqual({
      id: "c-1",
      href: "c-1",
      addressBook: "Personal",
      name: "Alice Smith",
      emails: ["alice@example.com"],
      address: "123 Main St, Springfield, IL 62701",
      notes: "Met at conference",
    });
  });

  it("returns null for not found", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse([
      "ContactCard/get",
      { list: [], notFound: ["c-999"] },
      "0",
    ]);

    const contact = await backend.getContact("c-999");
    expect(contact).toBeNull();
  });
});

describe("searchContacts", () => {
  it("sends name filter to JMAP query", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse(
      ["ContactCard/query", { ids: ["c-1"] }, "0"],
      [
        "ContactCard/get",
        {
          list: [
            {
              id: "c-1",
              name: { full: "Alice Smith" },
              emails: { e1: { address: "alice@example.com" } },
              addressBookIds: { "ab-1": true },
            },
          ],
        },
        "1",
      ]
    );

    const results = await backend.searchContacts({ query: "Alice" });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Smith");

    // Verify the filter
    const requestBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(requestBody.methodCalls[0][1].filter).toEqual({ name: "Alice" });
  });
});

describe("address formatting", () => {
  it("formats address from components", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse([
      "ContactCard/get",
      {
        list: [
          {
            id: "c-1",
            name: { full: "Test" },
            addresses: {
              a1: {
                components: [
                  { kind: "streetAddress", value: "123 Main St" },
                  { kind: "locality", value: "Springfield" },
                  { kind: "region", value: "IL" },
                  { kind: "postcode", value: "62701" },
                ],
              },
            },
            addressBookIds: { "ab-1": true },
          },
        ],
      },
      "0",
    ]);

    const contact = await backend.getContact("c-1");
    expect(contact?.address).toBe("123 Main St, Springfield, IL, 62701");
  });
});

describe("name assembly", () => {
  it("handles empty name gracefully", async () => {
    const backend = makeBackend();

    mockJmapResponse([
      "AddressBook/get",
      { list: [{ id: "ab-1", name: "Personal" }] },
      "0",
    ]);
    await backend.connect();

    mockJmapResponse(
      ["ContactCard/query", { ids: ["c-1"] }, "0"],
      [
        "ContactCard/get",
        {
          list: [
            {
              id: "c-1",
              name: null,
              addressBookIds: { "ab-1": true },
            },
          ],
        },
        "1",
      ]
    );

    const contacts = await backend.listContacts();
    expect(contacts[0].name).toBe("");
  });
});
