import { ContactsBackend, AddressBookInfo, Contact, ListContactsOptions, SearchContactsOptions } from "../types.js";
import { WebDavClient } from "../webdav/client.js";
import { hasElement, extractText } from "../webdav/xml.js";
import { parseVCards, ParsedVCard } from "./parser.js";

export interface CardDavConfig {
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

const PROPFIND_ADDRESSBOOK_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set/>
  </d:prop>
</d:propfind>`;

const PROPFIND_ADDRESSBOOKS = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <card:addressbook-description/>
  </d:prop>
</d:propfind>`;

const REPORT_CONTACTS = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
</card:addressbook-query>`;

function vcardToContact(vcard: ParsedVCard, href: string, addressBook: string): Contact {
  const contact: Contact = {
    id: vcard.uid,
    href,
    addressBook,
    name: vcard.fn,
  };
  if (vcard.emails.length > 0) contact.emails = vcard.emails;
  if (vcard.phones.length > 0) contact.phones = vcard.phones;
  if (vcard.org) contact.organization = vcard.org;
  if (vcard.title) contact.title = vcard.title;
  if (vcard.adr) contact.address = vcard.adr;
  if (vcard.note) contact.notes = vcard.note;
  return contact;
}

export class CardDavBackend implements ContactsBackend {
  private client: WebDavClient;
  private config: CardDavConfig;
  private addressBooks: AddressBookInfo[] = [];

  constructor(config: CardDavConfig) {
    this.config = config;
    this.client = new WebDavClient({
      baseUrl: config.url,
      username: config.username,
      password: config.password,
    });
  }

  async connect(): Promise<void> {
    let addressBookHomeUrl: string;

    try {
      // Step 1: Discover current-user-principal
      const principalEntries = await this.client.propfind(this.config.url, PROPFIND_PRINCIPAL, "0");
      const principalEntry = principalEntries[0];
      const principalHref = principalEntry?.props.get("current-user-principal");
      const principalUrl = principalHref ? extractText(principalHref, "href") : undefined;

      if (!principalUrl) {
        throw new Error("No current-user-principal found");
      }

      // Step 2: Discover addressbook-home-set
      const homeEntries = await this.client.propfind(principalUrl, PROPFIND_ADDRESSBOOK_HOME, "0");
      const homeEntry = homeEntries[0];
      const homeSet = homeEntry?.props.get("addressbook-home-set");
      const homeUrl = homeSet ? extractText(homeSet, "href") : undefined;

      if (!homeUrl) {
        throw new Error("No addressbook-home-set found");
      }

      addressBookHomeUrl = homeUrl;
    } catch {
      // Fallback: treat config.url as the addressbook-home URL directly
      addressBookHomeUrl = this.config.url;
    }

    // Step 3: Discover address books
    const entries = await this.client.propfind(addressBookHomeUrl, PROPFIND_ADDRESSBOOKS, "1");

    this.addressBooks = [];
    for (const entry of entries) {
      const resourceType = entry.props.get("resourcetype") ?? "";
      if (!hasElement(resourceType, "addressbook")) continue;

      const name = entry.props.get("displayname") ?? entry.href;
      const description = entry.props.get("addressbook-description");

      const info: AddressBookInfo = { href: entry.href, name };
      if (description) info.description = description;
      this.addressBooks.push(info);
    }
  }

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    return this.addressBooks;
  }

  async listContacts(options?: ListContactsOptions): Promise<Contact[]> {
    const limit = options?.limit ?? 50;
    const targetBooks = options?.addressBook
      ? this.addressBooks.filter(b => b.name === options.addressBook)
      : this.addressBooks;

    const allContacts: Contact[] = [];

    for (const book of targetBooks) {
      const entries = await this.client.report(book.href, REPORT_CONTACTS);

      for (const entry of entries) {
        const addressData = entry.props.get("address-data");
        if (!addressData) continue;

        const vcards = parseVCards(addressData);
        for (const vcard of vcards) {
          allContacts.push(vcardToContact(vcard, entry.href, book.name));
        }
      }
    }

    allContacts.sort((a, b) => a.name.localeCompare(b.name));
    return allContacts.slice(0, limit);
  }

  async getContact(href: string): Promise<Contact | null> {
    let raw: string;
    try {
      raw = await this.client.get(href);
    } catch {
      return null;
    }

    const vcards = parseVCards(raw);
    if (vcards.length === 0) return null;

    // Infer address book name from href
    const book = this.addressBooks.find(b => href.startsWith(b.href));
    const addressBookName = book?.name ?? "Unknown";

    return vcardToContact(vcards[0], href, addressBookName);
  }

  async searchContacts(options: SearchContactsOptions): Promise<Contact[]> {
    const limit = options.limit ?? 50;
    const query = options.query.toLowerCase();

    // Fetch all contacts in scope (no limit for search — we filter after)
    const allContacts = await this.listContacts({
      addressBook: options.addressBook,
      limit: Number.MAX_SAFE_INTEGER,
    });

    const matches = allContacts.filter(c => {
      if (c.name.toLowerCase().includes(query)) return true;
      if (c.emails?.some(e => e.toLowerCase().includes(query))) return true;
      if (c.phones?.some(p => p.toLowerCase().includes(query))) return true;
      if (c.organization?.toLowerCase().includes(query)) return true;
      if (c.title?.toLowerCase().includes(query)) return true;
      return false;
    });

    return matches.slice(0, limit);
  }
}
