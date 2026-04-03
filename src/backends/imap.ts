import {
  AttachmentContent,
  EmailBackend,
  EmailMessage,
  ListMessagesOptions,
  SearchOptions,
  SendMessageOptions,
} from "../types.js";
import { ImapClient, ImapError } from "../imap/client.js";
import {
  parseFetchResponse,
  parseSearchResponse,
  parseListResponse,
  ParsedFetch,
  flattenAttachments,
  findBodyPart,
  decodePartContent,
} from "../imap/parser.js";
import { SmtpClient } from "../smtp/client.js";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  from?: string;
}

export class ImapBackend implements EmailBackend {
  private config: ImapConfig;
  private client: ImapClient | null = null;
  private folderList: string[] = [];
  private smtpConfig: SmtpConfig | undefined;
  private smtpClient: SmtpClient | null = null;

  sendMessage?: (options: SendMessageOptions) => Promise<{ id: string }>;

  constructor(config: ImapConfig, smtpConfig?: SmtpConfig) {
    this.config = config;
    this.smtpConfig = smtpConfig;
    if (smtpConfig) {
      this.sendMessage = this.sendMessageImpl.bind(this);
    }
  }

  async connect(): Promise<void> {
    this.client = new ImapClient();
    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      tls: this.config.tls,
    });

    // Login
    const escapedUser = quoteImapString(this.config.user);
    const escapedPass = quoteImapString(this.config.password);
    await this.client.command(`LOGIN ${escapedUser} ${escapedPass}`);

    // Cache folder list
    const listResponses = await this.client.command('LIST "" "*"');
    this.folderList = [];
    for (const resp of listResponses) {
      if (resp.type === "LIST") {
        const parsed = parseListResponse(resp.text);
        if (parsed) {
          this.folderList.push(parsed.name);
        }
      }
    }
    this.folderList.sort();

    // Connect SMTP if configured
    if (this.smtpConfig) {
      const smtp = this.smtpConfig;
      const useImplicitTls = smtp.port === 465;
      this.smtpClient = new SmtpClient();
      await this.smtpClient.connect({
        host: smtp.host,
        port: smtp.port,
        tls: useImplicitTls,
      });

      const fromAddr = smtp.from ?? smtp.user;
      const domain = fromAddr.split("@")[1] ?? "localhost";
      await this.smtpClient.ehlo(domain);

      if (smtp.tls && !useImplicitTls) {
        await this.smtpClient.startTls();
        await this.smtpClient.ehlo(domain);
      }

      await this.smtpClient.authPlain(smtp.user, smtp.password);
    }
  }

  async disconnect(): Promise<void> {
    if (this.smtpClient) {
      try {
        await this.smtpClient.quit();
      } catch {
        // Ignore errors during SMTP quit
      }
      this.smtpClient = null;
    }

    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
    this.folderList = [];
  }

  async listFolders(): Promise<string[]> {
    this.ensureConnected();
    return [...this.folderList];
  }

  async listMessages(options?: ListMessagesOptions): Promise<EmailMessage[]> {
    const client = this.ensureConnected();
    const folder = options?.folder ?? "INBOX";
    const limit = options?.limit ?? 25;
    const offset = options?.offset ?? 0;

    this.validateFolder(folder);

    // Select mailbox
    await client.command(`SELECT ${quoteImapString(folder)}`);

    // Search for all UIDs, then paginate
    const searchResponses = await client.command("UID SEARCH ALL");
    const allUids = this.extractSearchUids(searchResponses);

    if (allUids.length === 0) return [];

    // Take most recent UIDs (highest = newest), apply offset and limit
    const sorted = allUids.sort((a, b) => b - a);
    const page = sorted.slice(offset, offset + limit);
    if (page.length === 0) return [];

    // Fetch envelope and flags for these UIDs
    const uidSet = page.join(",");
    const fetchResponses = await client.command(
      `UID FETCH ${uidSet} (UID FLAGS ENVELOPE)`
    );

    return this.mapFetchResponses(fetchResponses, folder);
  }

  async getMessage(id: string): Promise<EmailMessage | null> {
    const client = this.ensureConnected();
    const { folder, uid } = decodeMessageId(id);
    this.validateFolder(folder);

    await client.command(`SELECT ${quoteImapString(folder)}`);

    try {
      const fetchResponses = await client.command(
        `UID FETCH ${uid} (UID FLAGS ENVELOPE BODY.PEEK[TEXT] BODYSTRUCTURE)`
      );

      const messages = this.mapFetchResponses(fetchResponses, folder);
      if (messages.length === 0) return null;

      const message = messages[0];

      // Extract body text and attachment metadata from FETCH response
      for (const resp of fetchResponses) {
        if (resp.type === "FETCH") {
          const parsed = parseFetchResponse(resp.text);
          if (parsed.uid === uid) {
            if (parsed.bodyText) {
              message.body = parsed.bodyText;
            }
            if (parsed.bodyStructure) {
              const attachments = flattenAttachments(parsed.bodyStructure);
              if (attachments.length > 0) {
                message.attachments = attachments;
              }
            }
          }
        }
      }

      return message;
    } catch {
      return null;
    }
  }

  async getAttachment(
    messageId: string,
    partId: string
  ): Promise<AttachmentContent> {
    if (!/^\d+(\.\d+)*$/.test(partId)) {
      throw new Error(`Invalid part ID: ${partId}`);
    }

    const client = this.ensureConnected();
    const { folder, uid } = decodeMessageId(messageId);
    this.validateFolder(folder);

    await client.command(`SELECT ${quoteImapString(folder)}`);

    const fetchResponses = await client.command(
      `UID FETCH ${uid} (BODYSTRUCTURE BODY.PEEK[${partId}])`
    );

    let structure: import("../imap/parser.js").ParsedBodyPart | undefined;
    let rawContent: string | undefined;

    for (const resp of fetchResponses) {
      if (resp.type === "FETCH") {
        const parsed = parseFetchResponse(resp.text);
        if (parsed.uid === uid) {
          structure = parsed.bodyStructure;
          rawContent = parsed.bodyParts?.get(partId);
        }
      }
    }

    if (!rawContent) {
      throw new Error(`Attachment part ${partId} not found`);
    }

    const part = structure ? findBodyPart(structure, partId) : null;
    const encoding = part?.encoding ?? "BASE64";
    const decoded = decodePartContent(rawContent, encoding);

    return {
      filename:
        part?.dispositionParams?.filename ||
        part?.parameters?.name ||
        `attachment-${partId}`,
      mimeType: part
        ? `${part.type}/${part.subtype}`
        : "application/octet-stream",
      content: decoded.toString("base64"),
    };
  }

  async searchMessages(options: SearchOptions): Promise<EmailMessage[]> {
    const client = this.ensureConnected();
    const folder = options.folder ?? "INBOX";
    const limit = options.limit ?? 25;

    this.validateFolder(folder);

    await client.command(`SELECT ${quoteImapString(folder)}`);

    // IMAP SEARCH TEXT searches headers and body
    const searchResponses = await client.command(
      `UID SEARCH TEXT ${quoteImapString(options.query)}`
    );
    const uids = this.extractSearchUids(searchResponses);

    if (uids.length === 0) return [];

    // Take most recent matches
    const sorted = uids.sort((a, b) => b - a);
    const page = sorted.slice(0, limit);

    const uidSet = page.join(",");
    const fetchResponses = await client.command(
      `UID FETCH ${uidSet} (UID FLAGS ENVELOPE)`
    );

    return this.mapFetchResponses(fetchResponses, folder);
  }

  private async sendMessageImpl(
    options: SendMessageOptions
  ): Promise<{ id: string }> {
    if (!this.smtpClient || !this.smtpConfig) {
      throw new Error("SMTP not configured");
    }

    const from = this.smtpConfig.from ?? this.smtpConfig.user;
    const domain = from.split("@")[1] ?? "localhost";
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`;
    const date = new Date().toUTCString();

    const sanitizedTo = options.to.map((a) => this.sanitizeHeader(a));
    const sanitizedCc = options.cc?.map((a) => this.sanitizeHeader(a));
    const sanitizedSubject = this.sanitizeHeader(options.subject);

    let message = "";
    message += `From: ${from}\r\n`;
    message += `To: ${sanitizedTo.join(", ")}\r\n`;
    if (sanitizedCc && sanitizedCc.length > 0) {
      message += `Cc: ${sanitizedCc.join(", ")}\r\n`;
    }
    message += `Subject: ${sanitizedSubject}\r\n`;
    message += `Date: ${date}\r\n`;
    message += `Message-ID: ${messageId}\r\n`;
    message += `MIME-Version: 1.0\r\n`;
    if (options.inReplyTo) {
      const sanitizedReplyTo = this.sanitizeHeader(options.inReplyTo);
      message += `In-Reply-To: ${sanitizedReplyTo}\r\n`;
      message += `References: ${sanitizedReplyTo}\r\n`;
    }

    if (options.htmlBody) {
      const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      message += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`;
      message += `\r\n`;
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/plain; charset=utf-8\r\n`;
      message += `\r\n`;
      message += options.textBody + `\r\n`;
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/html; charset=utf-8\r\n`;
      message += `\r\n`;
      message += options.htmlBody + `\r\n`;
      message += `--${boundary}--\r\n`;
    } else {
      message += `Content-Type: text/plain; charset=utf-8\r\n`;
      message += `\r\n`;
      message += options.textBody;
    }

    await this.smtpClient.mailFrom(from);
    const allRecipients = [
      ...options.to,
      ...(options.cc ?? []),
      ...(options.bcc ?? []),
    ];
    for (const recipient of allRecipients) {
      await this.smtpClient.rcptTo(recipient);
    }
    await this.smtpClient.data(message);

    return { id: messageId };
  }

  // --- Private helpers ---

  private sanitizeHeader(value: string): string {
    if (/[\r\n]/.test(value)) {
      throw new Error("Header value must not contain CR or LF");
    }
    return value;
  }

  private ensureConnected(): ImapClient {
    if (!this.client) {
      throw new Error("Not connected. Call connect() first.");
    }
    return this.client;
  }

  private validateFolder(folder: string): void {
    if (!this.folderList.includes(folder)) {
      throw new Error(`Unknown folder: ${folder}`);
    }
  }

  private extractSearchUids(responses: { type?: string; text: string }[]): number[] {
    for (const resp of responses) {
      if (resp.type === "SEARCH") {
        return parseSearchResponse(resp.text);
      }
    }
    return [];
  }

  private mapFetchResponses(
    responses: { type?: string; text: string }[],
    folder: string
  ): EmailMessage[] {
    const messages: EmailMessage[] = [];

    for (const resp of responses) {
      if (resp.type === "FETCH") {
        const parsed = parseFetchResponse(resp.text);
        if (parsed.uid && parsed.envelope) {
          messages.push(this.mapImapMessage(parsed, folder));
        }
      }
    }

    // Sort by UID descending (newest first)
    messages.sort((a, b) => {
      const uidA = decodeMessageId(a.id).uid;
      const uidB = decodeMessageId(b.id).uid;
      return uidB - uidA;
    });

    return messages;
  }

  private mapImapMessage(parsed: ParsedFetch, folder: string): EmailMessage {
    const env = parsed.envelope!;

    const message: EmailMessage = {
      id: encodeMessageId(folder, parsed.uid!),
      subject: env.subject,
      from: env.from[0]?.email ?? env.from[0]?.name ?? "",
      to: env.to.map((a) => a.email),
      date: env.date,
      snippet: "",
      isRead: parsed.flags?.includes("\\Seen") ?? false,
      folder,
    };

    const cc = env.cc.map((a) => a.email);
    if (cc.length > 0) {
      message.cc = cc;
    }

    return message;
  }
}

// --- Message ID encoding ---

export function encodeMessageId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

export function decodeMessageId(id: string): { folder: string; uid: number } {
  const lastColon = id.lastIndexOf(":");
  if (lastColon === -1) {
    throw new ImapError("invalidId", `Malformed message ID: ${id}`);
  }
  const folder = id.substring(0, lastColon);
  const uid = parseInt(id.substring(lastColon + 1), 10);
  if (isNaN(uid)) {
    throw new ImapError("invalidId", `Malformed UID in ID: ${id}`);
  }
  return { folder, uid };
}

// --- IMAP string quoting ---

function quoteImapString(value: string): string {
  if (/[\r\n\x00]/.test(value)) {
    throw new Error("IMAP string must not contain CR, LF, or NUL");
  }
  if (/[\s"\\(){}\x00-\x1f\x7f]/.test(value)) {
    return '"' + value.replace(/["\\]/g, "\\$&") + '"';
  }
  return value;
}
