/**
 * Shared interface that both IMAP and JMAP backends implement.
 * The MCP tool layer depends only on this interface, never on a specific backend.
 */

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  snippet: string;
  body?: string;
  isRead: boolean;
  folder: string;
}

export interface ListMessagesOptions {
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface SearchOptions {
  query: string;
  folder?: string;
  limit?: number;
}

export interface SendMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
}

export interface EmailBackend {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listFolders(): Promise<string[]>;
  listMessages(options?: ListMessagesOptions): Promise<EmailMessage[]>;
  getMessage(id: string): Promise<EmailMessage | null>;
  searchMessages(options: SearchOptions): Promise<EmailMessage[]>;
  sendMessage?(options: SendMessageOptions): Promise<{ id: string }>;
}
