import {
  ContactsBackend,
  AddressBookInfo,
  Contact,
  ListContactsOptions,
  SearchContactsOptions,
} from "../types.js";
import { JmapBackend, JmapSession, JmapError } from "./jmap.js";

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:contacts",
];

const CONTACT_LIST_PROPERTIES = [
  "id",
  "name",
  "emails",
  "phones",
  "organizations",
  "titles",
  "addressBookIds",
];

const CONTACT_FULL_PROPERTIES = [
  ...CONTACT_LIST_PROPERTIES,
  "addresses",
  "notes",
];

export class JmapContactsBackend implements ContactsBackend {
  private jmapBackend: JmapBackend;
  private token: string;
  private session!: JmapSession;
  private addressBooks: AddressBookInfo[] = [];
  private addressBookIdToName = new Map<string, string>();

  constructor(jmapBackend: JmapBackend, token: string) {
    this.jmapBackend = jmapBackend;
    this.token = token;
  }

  async connect(): Promise<void> {
    const session = this.jmapBackend.getSession();
    if (!session) {
      throw new Error("JMAP email backend must be connected before JMAP contacts");
    }
    this.session = session;

    // Fetch address books
    const responses = await this.jmapRequest([
      [
        "AddressBook/get",
        {
          accountId: this.session.accountId,
          properties: ["id", "name", "description", "isDefault"],
        },
        "0",
      ],
    ]);

    const abResponse = this.findResponse(responses, "AddressBook/get");
    this.addressBooks = [];
    this.addressBookIdToName.clear();

    for (const raw of abResponse.list) {
      const info: AddressBookInfo = {
        href: raw.id,
        name: raw.name ?? raw.id,
      };
      if (raw.description) info.description = raw.description;
      this.addressBooks.push(info);
      this.addressBookIdToName.set(raw.id, info.name);
    }
  }

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    return this.addressBooks;
  }

  async listContacts(options?: ListContactsOptions): Promise<Contact[]> {
    const limit = options?.limit ?? 50;

    const filter: Record<string, unknown> = {};
    if (options?.addressBook) {
      const bookId = this.findAddressBookId(options.addressBook);
      if (bookId) {
        filter.inAddressBook = bookId;
      }
    }

    const responses = await this.jmapRequest([
      [
        "ContactCard/query",
        {
          accountId: this.session.accountId,
          filter,
          sort: [{ property: "name/full", isAscending: true }],
          limit,
        },
        "0",
      ],
      [
        "ContactCard/get",
        {
          accountId: this.session.accountId,
          "#ids": {
            name: "ContactCard/query",
            path: "/ids",
            resultOf: "0",
          },
          properties: CONTACT_LIST_PROPERTIES,
        },
        "1",
      ],
    ]);

    const getResponse = this.findResponse(responses, "ContactCard/get");
    return getResponse.list.map((raw: any) => this.mapContactCard(raw, false));
  }

  async getContact(href: string): Promise<Contact | null> {
    const responses = await this.jmapRequest([
      [
        "ContactCard/get",
        {
          accountId: this.session.accountId,
          ids: [href],
          properties: CONTACT_FULL_PROPERTIES,
        },
        "0",
      ],
    ]);

    const getResponse = this.findResponse(responses, "ContactCard/get");
    if (getResponse.notFound?.includes(href)) return null;
    if (getResponse.list.length === 0) return null;

    return this.mapContactCard(getResponse.list[0], true);
  }

  async searchContacts(options: SearchContactsOptions): Promise<Contact[]> {
    const limit = options.limit ?? 50;

    const filter: Record<string, unknown> = { name: options.query };
    if (options.addressBook) {
      const bookId = this.findAddressBookId(options.addressBook);
      if (bookId) {
        filter.inAddressBook = bookId;
      }
    }

    const responses = await this.jmapRequest([
      [
        "ContactCard/query",
        {
          accountId: this.session.accountId,
          filter,
          limit,
        },
        "0",
      ],
      [
        "ContactCard/get",
        {
          accountId: this.session.accountId,
          "#ids": {
            name: "ContactCard/query",
            path: "/ids",
            resultOf: "0",
          },
          properties: CONTACT_LIST_PROPERTIES,
        },
        "1",
      ],
    ]);

    const getResponse = this.findResponse(responses, "ContactCard/get");
    return getResponse.list.map((raw: any) => this.mapContactCard(raw, false));
  }

  // --- Private helpers ---

  private mapContactCard(raw: any, full: boolean): Contact {
    const addressBookId = Object.keys(raw.addressBookIds ?? {})[0];
    const addressBook = addressBookId
      ? this.addressBookIdToName.get(addressBookId) ?? addressBookId
      : "";

    const contact: Contact = {
      id: raw.id,
      href: raw.id,
      addressBook,
      name: extractName(raw.name),
    };

    const emails = extractMapValues(raw.emails, "address");
    if (emails.length > 0) contact.emails = emails;

    const phones = extractMapValues(raw.phones, "phone");
    if (phones.length > 0) contact.phones = phones;

    const org = extractFirstOrganization(raw.organizations);
    if (org) contact.organization = org;

    const title = extractFirstTitle(raw.titles);
    if (title) contact.title = title;

    if (full) {
      const address = extractFirstAddress(raw.addresses);
      if (address) contact.address = address;

      const notes = extractNotes(raw.notes);
      if (notes) contact.notes = notes;
    }

    return contact;
  }

  private findAddressBookId(name: string): string | undefined {
    for (const [id, bookName] of this.addressBookIdToName) {
      if (bookName === name) return id;
    }
    return undefined;
  }

  private async jmapRequest(methodCalls: any[][]): Promise<any[][]> {
    const res = await fetch(this.session.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        using: USING,
        methodCalls,
      }),
    });

    if (!res.ok) {
      throw new Error(`JMAP request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const methodResponses: any[][] = data.methodResponses;

    for (const response of methodResponses) {
      if (response[0] === "error") {
        throw new JmapError(
          response[1].type ?? "unknown",
          response[1].description ?? "Unknown JMAP error"
        );
      }
    }

    return methodResponses;
  }

  private findResponse(responses: any[][], methodName: string): any {
    for (const response of responses) {
      if (response[0] === methodName) {
        return response[1];
      }
    }
    throw new Error(`Expected ${methodName} response not found`);
  }
}

// --- JSContact mapping helpers ---

/**
 * Extract display name from a JSContact Name object.
 * Prefers `full`, falls back to assembling from components.
 */
function extractName(name: any): string {
  if (!name) return "";
  if (name.full) return name.full;

  // Assemble from components
  if (name.components && Array.isArray(name.components)) {
    const parts = name.components
      .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((c: any) => c.value)
      .filter(Boolean);
    return parts.join(" ");
  }

  return "";
}

/**
 * Extract values from a JSContact Id-keyed map (e.g., emails, phones).
 * Each entry has a property like "address" for emails or "phone" for phones.
 */
function extractMapValues(map: any, valueKey: string): string[] {
  if (!map || typeof map !== "object") return [];
  return Object.values(map)
    .map((entry: any) => entry[valueKey])
    .filter(Boolean);
}

/**
 * Extract the first organization name from JSContact organizations map.
 */
function extractFirstOrganization(orgs: any): string | undefined {
  if (!orgs || typeof orgs !== "object") return undefined;
  const first = Object.values(orgs)[0] as any;
  return first?.name || undefined;
}

/**
 * Extract the first title from JSContact titles map.
 */
function extractFirstTitle(titles: any): string | undefined {
  if (!titles || typeof titles !== "object") return undefined;
  const first = Object.values(titles)[0] as any;
  return first?.name || undefined;
}

/**
 * Format the first address from JSContact addresses map.
 */
function extractFirstAddress(addresses: any): string | undefined {
  if (!addresses || typeof addresses !== "object") return undefined;
  const first = Object.values(addresses)[0] as any;
  if (!first) return undefined;

  // JSContact addresses have components or full
  if (first.full) return first.full;

  if (first.components && Array.isArray(first.components)) {
    const parts = first.components
      .map((c: any) => c.value)
      .filter(Boolean);
    return parts.join(", ");
  }

  // Fallback: assemble from legacy-style fields
  const parts = [
    first.street,
    first.locality,
    first.region,
    first.postcode,
    first.country,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Extract notes text from JSContact notes map.
 */
function extractNotes(notes: any): string | undefined {
  if (!notes || typeof notes !== "object") return undefined;
  const parts = Object.values(notes)
    .map((entry: any) => entry.note)
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
