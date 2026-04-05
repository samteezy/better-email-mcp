import {
  AttachmentContent,
  EmailBackend,
  EmailMessage,
  ListMessagesOptions,
  MoveMessagesOptions,
  SearchOptions,
  SendMessageOptions,
  TagMessagesOptions,
} from "../types.js";
import { validateTagName } from "./imap.js";

export interface JmapConfig {
  token: string;
  sessionUrl?: string;
}

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  downloadUrl: string;
}

interface JmapIdentity {
  id: string;
  email: string;
  name: string;
}

interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export class JmapError extends Error {
  constructor(
    public readonly type: string,
    public readonly description: string
  ) {
    super(`JMAP error [${type}]: ${description}`);
    this.name = "JmapError";
  }
}

// JMAP response types
type JmapMethodCall = [string, Record<string, unknown>, string];
type JmapMethodResponse = [string, Record<string, unknown>, string];

interface JmapEmailAddress {
  name?: string;
  email: string;
}

interface JmapBodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  size?: number;
  cid?: string;
  disposition?: string;
}

interface JmapEmailData {
  id: string;
  subject?: string;
  from?: JmapEmailAddress[];
  to?: JmapEmailAddress[];
  cc?: JmapEmailAddress[];
  receivedAt?: string;
  preview?: string;
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
  textBody?: JmapBodyPart[];
  bodyValues?: Record<string, { value: string }>;
  attachments?: JmapBodyPart[];
}

const DEFAULT_SESSION_URL = "https://api.fastmail.com/.well-known/jmap";
const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];
const LIST_PROPERTIES = [
  "id",
  "subject",
  "from",
  "to",
  "cc",
  "receivedAt",
  "preview",
  "keywords",
  "mailboxIds",
  "hasAttachment",
];
const FULL_PROPERTIES = [
  ...LIST_PROPERTIES,
  "textBody",
  "htmlBody",
  "bodyValues",
  "attachments",
];

export class JmapBackend implements EmailBackend {
  private config: JmapConfig;
  private session: JmapSession | null = null;
  private identity: JmapIdentity | null = null;
  private mailboxCache = new Map<string, string>(); // id → path
  private mailboxNameToId = new Map<string, string>(); // path → id

  constructor(config: JmapConfig) {
    this.config = config;
  }

  getSession(): JmapSession | null {
    return this.session;
  }

  async connect(): Promise<void> {
    // 1. Discover session
    const sessionUrl = this.config.sessionUrl ?? DEFAULT_SESSION_URL;
    const sessionRes = await fetch(sessionUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    if (!sessionRes.ok) {
      throw new Error(
        `JMAP session discovery failed: ${sessionRes.status} ${sessionRes.statusText}`
      );
    }
    const sessionData = await sessionRes.json();
    this.session = {
      apiUrl: sessionData.apiUrl,
      accountId:
        sessionData.primaryAccounts["urn:ietf:params:jmap:mail"],
      downloadUrl: sessionData.downloadUrl ?? "",
    };

    // 2. Fetch mailboxes and identity in one request
    const responses = await this.jmapRequest([
      [
        "Mailbox/get",
        {
          accountId: this.session.accountId,
          properties: ["id", "name", "parentId", "role"],
        },
        "0",
      ],
      [
        "Identity/get",
        {
          accountId: this.session.accountId,
        },
        "1",
      ],
    ]);

    // Process mailboxes
    const mailboxResponse = this.findResponse(responses, "Mailbox/get");
    const mailboxes: JmapMailbox[] = mailboxResponse.list;
    const mailboxesById = new Map<string, JmapMailbox>();
    for (const mb of mailboxes) {
      mailboxesById.set(mb.id, mb);
    }
    this.mailboxCache.clear();
    this.mailboxNameToId.clear();
    for (const mb of mailboxes) {
      const path = this.buildMailboxPath(mb, mailboxesById);
      this.mailboxCache.set(mb.id, path);
      this.mailboxNameToId.set(path, mb.id);
    }

    // Process identity
    const identityResponse = this.findResponse(responses, "Identity/get");
    const identities = identityResponse.list;
    if (identities.length > 0) {
      this.identity = {
        id: identities[0].id,
        email: identities[0].email,
        name: identities[0].name ?? "",
      };
    }
  }

  async disconnect(): Promise<void> {
    this.session = null;
    this.identity = null;
    this.mailboxCache.clear();
    this.mailboxNameToId.clear();
  }

  async listFolders(): Promise<string[]> {
    return Array.from(this.mailboxNameToId.keys()).sort();
  }

  async listMessages(options?: ListMessagesOptions): Promise<EmailMessage[]> {
    this.ensureConnected();

    const filter: Record<string, unknown> = {};
    if (options?.folder) {
      const mailboxId = this.mailboxNameToId.get(options.folder);
      if (!mailboxId) {
        throw new Error(`Unknown folder: ${options.folder}`);
      }
      filter.inMailbox = mailboxId;
    }

    const responses = await this.jmapRequest([
      [
        "Email/query",
        {
          accountId: this.session!.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          position: options?.offset ?? 0,
          limit: options?.limit ?? 25,
          collapseThreads: true,
        },
        "0",
      ],
      [
        "Email/get",
        {
          accountId: this.session!.accountId,
          "#ids": {
            name: "Email/query",
            path: "/ids",
            resultOf: "0",
          },
          properties: LIST_PROPERTIES,
        },
        "1",
      ],
    ]);

    const emailResponse = this.findResponse(responses, "Email/get");
    return emailResponse.list.map((raw: JmapEmailData) => this.mapJmapEmail(raw));
  }

  async getMessage(id: string): Promise<EmailMessage | null> {
    this.ensureConnected();

    const responses = await this.jmapRequest([
      [
        "Email/get",
        {
          accountId: this.session!.accountId,
          ids: [id],
          properties: FULL_PROPERTIES,
          fetchAllBodyValues: true,
          bodyProperties: [
            "partId",
            "blobId",
            "type",
            "name",
            "size",
            "cid",
            "disposition",
          ],
        },
        "0",
      ],
    ]);

    const emailResponse = this.findResponse(responses, "Email/get");
    if (emailResponse.notFound?.includes(id)) {
      return null;
    }
    if (emailResponse.list.length === 0) {
      return null;
    }

    const raw: JmapEmailData = emailResponse.list[0];
    const message = this.mapJmapEmail(raw);

    // Assemble body from textBody parts
    const textParts: JmapBodyPart[] = raw.textBody ?? [];
    const bodyText = textParts
      .map((part) => raw.bodyValues?.[part.partId ?? ""]?.value ?? "")
      .join("\n");
    if (bodyText) {
      message.body = bodyText;
    }

    // Map server-computed attachments (RFC 8621 §4.1.4)
    const rawAttachments = raw.attachments ?? [];
    if (rawAttachments.length > 0) {
      message.attachments = rawAttachments.map((part) => ({
        partId: part.blobId ?? "",
        filename: part.name ?? `attachment-${part.partId ?? "unknown"}`,
        mimeType: part.type || "application/octet-stream",
        size: part.size ?? 0,
        isInline: part.disposition === "inline" && !!part.cid,
      }));
    }

    return message;
  }

  async getAttachment(
    messageId: string,
    partId: string,
    maxSize?: number
  ): Promise<AttachmentContent> {
    const session = this.ensureConnected();

    // Fetch the server-computed attachments list (RFC 8621 §4.1.4)
    const responses = await this.jmapRequest([
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: [messageId],
          properties: ["attachments"],
          bodyProperties: [
            "partId",
            "blobId",
            "type",
            "name",
            "size",
            "cid",
            "disposition",
          ],
        },
        "0",
      ],
    ]);

    const emailResponse = this.findResponse(responses, "Email/get");
    if (
      emailResponse.list.length === 0 ||
      emailResponse.notFound?.includes(messageId)
    ) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const attachments: JmapBodyPart[] = emailResponse.list[0].attachments ?? [];
    const part = attachments.find((p) => p.blobId === partId);
    if (!part) {
      throw new Error(`Attachment part ${partId} not found`);
    }

    if (maxSize && (part.size ?? 0) > maxSize) {
      throw new Error(
        `Attachment too large: ${part.size} bytes (max ${maxSize})`
      );
    }

    // Download blob via downloadUrl template
    const downloadUrl = session.downloadUrl
      .replace("{accountId}", encodeURIComponent(session.accountId))
      .replace("{blobId}", encodeURIComponent(partId))
      .replace("{type}", encodeURIComponent(part.type ?? "application/octet-stream"))
      .replace("{name}", encodeURIComponent(part.name ?? "attachment"));

    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to download attachment: ${res.status} ${res.statusText}`
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    return {
      filename: part.name ?? "attachment",
      mimeType: part.type ?? "application/octet-stream",
      content: buffer.toString("base64"),
    };
  }

  async searchMessages(options: SearchOptions): Promise<EmailMessage[]> {
    this.ensureConnected();

    const filter: Record<string, unknown> = { text: options.query };
    if (options.folder) {
      const mailboxId = this.mailboxNameToId.get(options.folder);
      if (!mailboxId) {
        throw new Error(`Unknown folder: ${options.folder}`);
      }
      filter.inMailbox = mailboxId;
    }

    const responses = await this.jmapRequest([
      [
        "Email/query",
        {
          accountId: this.session!.accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: options.limit ?? 25,
        },
        "0",
      ],
      [
        "Email/get",
        {
          accountId: this.session!.accountId,
          "#ids": {
            name: "Email/query",
            path: "/ids",
            resultOf: "0",
          },
          properties: LIST_PROPERTIES,
        },
        "1",
      ],
    ]);

    const emailResponse = this.findResponse(responses, "Email/get");
    return emailResponse.list.map((raw: JmapEmailData) => this.mapJmapEmail(raw));
  }

  async sendMessage(options: SendMessageOptions): Promise<{ id: string }> {
    this.ensureConnected();
    if (!this.identity) {
      throw new Error("No identity available for sending");
    }

    // Find drafts mailbox
    let draftsId: string | undefined;
    for (const [id, path] of this.mailboxCache) {
      if (path.toLowerCase() === "drafts") {
        draftsId = id;
        break;
      }
    }
    if (!draftsId) {
      throw new Error("Drafts mailbox not found");
    }

    const emailCreate: Record<string, unknown> = {
      mailboxIds: { [draftsId]: true },
      from: [{ name: this.identity.name, email: this.identity.email }],
      to: options.to.map((email) => ({ email })),
      ...(options.cc?.length
        ? { cc: options.cc.map((email) => ({ email })) }
        : {}),
      ...(options.bcc?.length
        ? { bcc: options.bcc.map((email) => ({ email })) }
        : {}),
      subject: options.subject,
      textBody: [{ partId: "textBody", type: "text/plain" }],
      bodyValues: {
        textBody: { value: options.textBody },
        ...(options.htmlBody
          ? { htmlBody: { value: options.htmlBody } }
          : {}),
      },
      ...(options.htmlBody
        ? { htmlBody: [{ partId: "htmlBody", type: "text/html" }] }
        : {}),
      keywords: { $draft: true },
    };
    if (options.inReplyTo) {
      emailCreate.inReplyTo = [options.inReplyTo];
    }

    const responses = await this.jmapRequest([
      [
        "Email/set",
        {
          accountId: this.session!.accountId,
          create: { draft: emailCreate },
        },
        "0",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: this.session!.accountId,
          create: {
            submission: {
              emailId: "#draft",
              identityId: this.identity.id,
            },
          },
        },
        "1",
      ],
    ]);

    const emailSetResponse = this.findResponse(responses, "Email/set");
    const createdId = emailSetResponse.created?.draft?.id;
    if (!createdId) {
      const err = emailSetResponse.notCreated?.draft;
      throw new JmapError(
        err?.type ?? "unknown",
        err?.description ?? "Failed to create email"
      );
    }

    return { id: createdId };
  }

  async tagMessages(
    options: TagMessagesOptions
  ): Promise<{ tagged: string[] }> {
    this.ensureConnected();

    validateTagName(options.tag);

    // Build per-email update using JMAP patch paths
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of options.ids) {
      update[id] = {
        [`keywords/${options.tag}`]:
          options.action === "add" ? true : null,
      };
    }

    const responses = await this.jmapRequest([
      [
        "Email/set",
        {
          accountId: this.session!.accountId,
          update,
        },
        "0",
      ],
    ]);

    const setResponse = this.findResponse(responses, "Email/set");
    const tagged: string[] = [];
    const updated = setResponse.updated ?? {};
    for (const id of options.ids) {
      if (id in updated || updated[id] !== undefined) {
        tagged.push(id);
      }
    }

    // Report errors for any that weren't updated
    const notUpdated = setResponse.notUpdated ?? {};
    if (Object.keys(notUpdated).length > 0) {
      const errors = Object.entries(notUpdated)
        .map(
          ([id, err]: [string, unknown]) =>
            `${id}: ${(err as { description?: string }).description ?? "unknown error"}`
        )
        .join("; ");
      throw new Error(`Failed to tag some messages: ${errors}`);
    }

    return { tagged: options.ids };
  }

  async moveMessages(
    options: MoveMessagesOptions
  ): Promise<{ moved: string[] }> {
    this.ensureConnected();

    const destId = this.mailboxNameToId.get(options.folder);
    if (!destId) {
      throw new Error(`Unknown folder: ${options.folder}`);
    }

    // First, fetch current mailboxIds for all messages so we can remove them
    const fetchResponses = await this.jmapRequest([
      [
        "Email/get",
        {
          accountId: this.session!.accountId,
          ids: options.ids,
          properties: ["mailboxIds"],
        },
        "0",
      ],
    ]);

    const emailResponse = this.findResponse(fetchResponses, "Email/get");
    const emails: { id: string; mailboxIds: Record<string, boolean> }[] =
      emailResponse.list ?? [];

    // Build update: set destination to true, set all current mailboxes to null
    const update: Record<string, Record<string, unknown>> = {};
    for (const email of emails) {
      const patch: Record<string, unknown> = {
        [`mailboxIds/${destId}`]: true,
      };
      for (const currentMailboxId of Object.keys(email.mailboxIds ?? {})) {
        if (currentMailboxId !== destId) {
          patch[`mailboxIds/${currentMailboxId}`] = null;
        }
      }
      update[email.id] = patch;
    }

    if (Object.keys(update).length === 0) {
      return { moved: [] };
    }

    const setResponses = await this.jmapRequest([
      [
        "Email/set",
        {
          accountId: this.session!.accountId,
          update,
        },
        "0",
      ],
    ]);

    const setResponse = this.findResponse(setResponses, "Email/set");
    const notUpdated = setResponse.notUpdated ?? {};
    if (Object.keys(notUpdated).length > 0) {
      const errors = Object.entries(notUpdated)
        .map(
          ([id, err]: [string, unknown]) =>
            `${id}: ${(err as { description?: string }).description ?? "unknown error"}`
        )
        .join("; ");
      throw new Error(`Failed to move some messages: ${errors}`);
    }

    return { moved: Object.keys(update) };
  }

  // --- Private helpers ---

  private ensureConnected(): JmapSession {
    if (!this.session) {
      throw new Error("Not connected. Call connect() first.");
    }
    return this.session;
  }

  async jmapRequest(
    methodCalls: JmapMethodCall[],
    using: string[] = USING
  ): Promise<JmapMethodResponse[]> {
    const session = this.ensureConnected();

    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({
        using,
        methodCalls,
      }),
    });

    if (!res.ok) {
      throw new Error(`JMAP request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const methodResponses: JmapMethodResponse[] = data.methodResponses;

    // Check for method-level errors
    for (const response of methodResponses) {
      if (response[0] === "error") {
        const err = response[1] as { type?: string; description?: string };
        throw new JmapError(
          err.type ?? "unknown",
          err.description ?? "Unknown JMAP error"
        );
      }
    }

    return methodResponses;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findResponse(responses: JmapMethodResponse[], methodName: string): any {
    for (const response of responses) {
      if (response[0] === methodName) {
        return response[1];
      }
    }
    throw new Error(`Expected ${methodName} response not found`);
  }

  private buildMailboxPath(
    mailbox: JmapMailbox,
    mailboxesById: Map<string, JmapMailbox>
  ): string {
    const parts: string[] = [mailbox.name];
    let current = mailbox;
    while (current.parentId) {
      const parent = mailboxesById.get(current.parentId);
      if (!parent) break;
      parts.unshift(parent.name);
      current = parent;
    }
    return parts.join("/");
  }


  private mapJmapEmail(raw: JmapEmailData): EmailMessage {
    const mailboxId = Object.keys(raw.mailboxIds ?? {})[0];
    const folder = mailboxId
      ? this.mailboxCache.get(mailboxId) ?? mailboxId
      : "";

    const message: EmailMessage = {
      id: raw.id,
      subject: raw.subject ?? "",
      from: raw.from?.[0]?.email ?? raw.from?.[0]?.name ?? "",
      to: (raw.to ?? []).map((a) => a.email),
      date: raw.receivedAt ?? "",
      snippet: raw.preview ?? "",
      isRead: raw.keywords?.$seen === true,
      folder,
    };

    const cc = (raw.cc ?? []).map((a) => a.email);
    if (cc.length > 0) {
      message.cc = cc;
    }

    // Expose custom keywords as tags — exclude $-prefixed system keywords
    const tags = Object.keys(raw.keywords ?? {}).filter(
      (k) => !k.startsWith("$")
    );
    if (tags.length > 0) {
      message.tags = tags;
    }

    return message;
  }
}
