import {
  AttachmentContent,
  AttachmentInfo,
  EmailBackend,
  EmailMessage,
  ListMessagesOptions,
  SearchOptions,
  SendMessageOptions,
} from "../types.js";

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
  "bodyStructure",
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

  getToken(): string {
    return this.config.token;
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
    return emailResponse.list.map((raw: any) => this.mapJmapEmail(raw));
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

    const raw = emailResponse.list[0];
    const message = this.mapJmapEmail(raw);

    // Assemble body from textBody parts
    const textParts: any[] = raw.textBody ?? [];
    const bodyText = textParts
      .map((part: any) => raw.bodyValues?.[part.partId]?.value ?? "")
      .join("\n");
    if (bodyText) {
      message.body = bodyText;
    }

    // Extract attachment metadata from bodyStructure
    if (raw.bodyStructure) {
      const attachments = this.extractJmapAttachments(raw.bodyStructure);
      if (attachments.length > 0) {
        message.attachments = attachments;
      }
    }

    return message;
  }

  async getAttachment(
    messageId: string,
    partId: string
  ): Promise<AttachmentContent> {
    const session = this.ensureConnected();

    // Fetch message to find the part metadata
    const responses = await this.jmapRequest([
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: [messageId],
          properties: ["bodyStructure"],
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

    const raw = emailResponse.list[0];
    const part = this.findJmapPart(raw.bodyStructure, partId);
    if (!part) {
      throw new Error(`Attachment part ${partId} not found`);
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
    return emailResponse.list.map((raw: any) => this.mapJmapEmail(raw));
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

  // --- Private helpers ---

  private ensureConnected(): JmapSession {
    if (!this.session) {
      throw new Error("Not connected. Call connect() first.");
    }
    return this.session;
  }

  private async jmapRequest(methodCalls: any[][]): Promise<any[][]> {
    const session = this.ensureConnected();

    const res = await fetch(session.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.token}`,
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

    // Check for method-level errors
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

  private extractJmapAttachments(bodyStructure: any): AttachmentInfo[] {
    const attachments: AttachmentInfo[] = [];
    this.collectJmapAttachments(bodyStructure, attachments);
    return attachments;
  }

  private collectJmapAttachments(part: any, out: AttachmentInfo[]): void {
    if (part.subParts) {
      for (const sub of part.subParts) {
        this.collectJmapAttachments(sub, out);
      }
      return;
    }

    // Skip text body parts unless explicitly attached
    const type: string = part.type ?? "";
    if (
      (type === "text/plain" || type === "text/html") &&
      part.disposition !== "attachment"
    ) {
      return;
    }

    // Skip multipart containers
    if (type.startsWith("multipart/")) return;

    // Only include parts that have a blobId (downloadable)
    if (!part.blobId) return;

    out.push({
      partId: part.blobId,
      filename: part.name ?? `attachment-${part.partId ?? "unknown"}`,
      mimeType: type || "application/octet-stream",
      size: part.size ?? 0,
      isInline: part.disposition === "inline" && !!part.cid,
    });
  }

  private findJmapPart(bodyStructure: any, blobId: string): any | null {
    if (bodyStructure.blobId === blobId) return bodyStructure;
    if (bodyStructure.subParts) {
      for (const sub of bodyStructure.subParts) {
        const found = this.findJmapPart(sub, blobId);
        if (found) return found;
      }
    }
    return null;
  }

  private mapJmapEmail(raw: any): EmailMessage {
    const mailboxId = Object.keys(raw.mailboxIds ?? {})[0];
    const folder = mailboxId
      ? this.mailboxCache.get(mailboxId) ?? mailboxId
      : "";

    const message: EmailMessage = {
      id: raw.id,
      subject: raw.subject ?? "",
      from: raw.from?.[0]?.email ?? raw.from?.[0]?.name ?? "",
      to: (raw.to ?? []).map((a: any) => a.email),
      date: raw.receivedAt ?? "",
      snippet: raw.preview ?? "",
      isRead: raw.keywords?.$seen === true,
      folder,
    };

    const cc = (raw.cc ?? []).map((a: any) => a.email);
    if (cc.length > 0) {
      message.cc = cc;
    }

    return message;
  }
}
