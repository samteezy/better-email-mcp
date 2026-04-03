import {
  ContactsBackend,
  AddressBookInfo,
  Contact,
  ListContactsOptions,
  SearchContactsOptions,
} from "../types.js";
import { JmapBackend, JmapSession } from "./jmap.js";

// JSContact types
type JSContactMap = Record<string, Record<string, unknown>> | undefined | null;

interface JSContactNameComponent {
  value?: string;
  sortOrder?: number;
}

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

interface JmapContactCardData {
  id: string;
  name?: { full?: string; components?: JSContactNameComponent[] } | null;
  emails?: JSContactMap;
  phones?: JSContactMap;
  organizations?: JSContactMap;
  titles?: JSContactMap;
  addresses?: JSContactMap;
  notes?: JSContactMap;
  addressBookIds?: Record<string, boolean>;
}

export class JmapContactsBackend implements ContactsBackend {
  private jmapBackend: JmapBackend;
  private session!: JmapSession;
  private addressBooks: AddressBookInfo[] = [];
  private addressBookIdToName = new Map<string, string>();

  constructor(jmapBackend: JmapBackend) {
    this.jmapBackend = jmapBackend;
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
    return getResponse.list.map((raw: JmapContactCardData) => this.mapContactCard(raw, false));
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
    return getResponse.list.map((raw: JmapContactCardData) => this.mapContactCard(raw, false));
  }

  // --- Private helpers ---

  private mapContactCard(raw: JmapContactCardData, full: boolean): Contact {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async jmapRequest(methodCalls: [string, Record<string, unknown>, string][]): Promise<any[][]> {
    return this.jmapBackend.jmapRequest(methodCalls, USING);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findResponse(responses: any[][], methodName: string): any {
    return this.jmapBackend.findResponse(responses as [string, Record<string, unknown>, string][], methodName);
  }
}

// --- JSContact mapping helpers ---

function extractName(name: { full?: string; components?: JSContactNameComponent[] } | undefined | null): string {
  if (!name) return "";
  if (name.full) return name.full;

  if (name.components && Array.isArray(name.components)) {
    const parts = name.components
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((c) => c.value)
      .filter(Boolean);
    return parts.join(" ");
  }

  return "";
}

function extractMapValues(map: JSContactMap, valueKey: string): string[] {
  if (!map || typeof map !== "object") return [];
  return Object.values(map)
    .map((entry) => entry[valueKey] as string | undefined)
    .filter(Boolean) as string[];
}

function extractFirstOrganization(orgs: JSContactMap): string | undefined {
  if (!orgs || typeof orgs !== "object") return undefined;
  const first = Object.values(orgs)[0];
  return (first?.name as string) || undefined;
}

function extractFirstTitle(titles: JSContactMap): string | undefined {
  if (!titles || typeof titles !== "object") return undefined;
  const first = Object.values(titles)[0];
  return (first?.name as string) || undefined;
}

function extractFirstAddress(addresses: JSContactMap): string | undefined {
  if (!addresses || typeof addresses !== "object") return undefined;
  const first = Object.values(addresses)[0];
  if (!first) return undefined;

  if (first.full) return first.full as string;

  if (first.components && Array.isArray(first.components)) {
    const parts = (first.components as JSContactNameComponent[])
      .map((c) => c.value)
      .filter(Boolean);
    return parts.join(", ");
  }

  const parts = [
    first.street,
    first.locality,
    first.region,
    first.postcode,
    first.country,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractNotes(notes: JSContactMap): string | undefined {
  if (!notes || typeof notes !== "object") return undefined;
  const parts = Object.values(notes)
    .map((entry) => entry.note as string | undefined)
    .filter(Boolean) as string[];
  return parts.length > 0 ? parts.join("\n") : undefined;
}
