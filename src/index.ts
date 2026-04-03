#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JmapBackend } from "./backends/jmap.js";
import { JmapContactsBackend } from "./backends/jmap-contacts.js";
import { ImapBackend, SmtpConfig } from "./backends/imap.js";
import { CalDavBackend } from "./caldav/backend.js";
import { CardDavBackend } from "./carddav/backend.js";
import { registerEmailTools } from "./tools/register.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerContactTools } from "./tools/contacts.js";
import { EmailBackend, ContactsBackend } from "./types.js";

function createBackend(): EmailBackend {
  const backendType = process.env.EMAIL_BACKEND ?? "jmap";

  if (backendType === "jmap") {
    const token = process.env.JMAP_TOKEN;
    if (!token) {
      throw new Error("JMAP_TOKEN environment variable is required");
    }
    return new JmapBackend({
      token,
      sessionUrl: process.env.JMAP_SESSION_URL,
    });
  }

  if (backendType === "imap") {
    const host = process.env.IMAP_HOST;
    const user = process.env.IMAP_USER;
    const password = process.env.IMAP_PASSWORD;
    if (!host || !user || !password) {
      throw new Error(
        "IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables are required"
      );
    }
    let smtpConfig: SmtpConfig | undefined;
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      const smtpUser = process.env.SMTP_USER;
      const smtpPassword = process.env.SMTP_PASSWORD;
      if (!smtpUser || !smtpPassword) {
        throw new Error(
          "SMTP_USER and SMTP_PASSWORD are required when SMTP_HOST is set"
        );
      }
      smtpConfig = {
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT ?? "587", 10),
        user: smtpUser,
        password: smtpPassword,
        tls: process.env.SMTP_TLS !== "false",
        from: process.env.SMTP_FROM,
      };
    }

    return new ImapBackend(
      {
        host,
        port: parseInt(process.env.IMAP_PORT ?? "993", 10),
        user,
        password,
        tls: process.env.IMAP_TLS !== "false",
      },
      smtpConfig
    );
  }

  throw new Error(`Unknown backend: ${backendType}`);
}

const server = new McpServer({
  name: "better-email-mcp",
  version: "0.6.3",
});

const backend = createBackend();
registerEmailTools(server, backend);

// CalDAV — activates when CALDAV_URL is set
let calendarBackend: CalDavBackend | null = null;
if (process.env.CALDAV_URL) {
  const username = process.env.CALDAV_USERNAME;
  const password = process.env.CALDAV_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "CALDAV_USERNAME and CALDAV_PASSWORD are required when CALDAV_URL is set"
    );
  }
  calendarBackend = new CalDavBackend({
    url: process.env.CALDAV_URL,
    username,
    password,
  });
  registerCalendarTools(server, calendarBackend);
  registerTaskTools(server, calendarBackend);
}

// Contacts — CardDAV when CARDDAV_URL is set, otherwise JMAP contacts when using JMAP backend
let contactsBackend: ContactsBackend | null = null;
if (process.env.CARDDAV_URL) {
  const username = process.env.CARDDAV_USERNAME;
  const password = process.env.CARDDAV_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "CARDDAV_USERNAME and CARDDAV_PASSWORD are required when CARDDAV_URL is set"
    );
  }
  contactsBackend = new CardDavBackend({
    url: process.env.CARDDAV_URL,
    username,
    password,
  });
  registerContactTools(server, contactsBackend);
} else if (backend instanceof JmapBackend) {
  // JMAP contacts activate automatically — no extra config needed
  contactsBackend = new JmapContactsBackend(backend);
  registerContactTools(server, contactsBackend);
}

async function main() {
  await backend.connect();
  if (calendarBackend) await calendarBackend.connect();
  if (contactsBackend) await contactsBackend.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
