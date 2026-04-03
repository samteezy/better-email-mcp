import { writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EmailBackend, EmailMessage } from "../types.js";
import {
  errorResult,
  jsonResult,
  parseDisabledTools,
  toolEnabled,
} from "./helpers.js";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
const ATTACHMENT_DIR = resolve(
  process.env.ATTACHMENT_DIR || join(homedir(), "Downloads")
);

function validateSavePath(saveTo: string): string {
  const resolved = resolve(saveTo);
  const rel = relative(ATTACHMENT_DIR, resolved);
  if (rel.startsWith("..") || resolve(ATTACHMENT_DIR, rel) !== resolved) {
    throw new Error(
      `saveTo must be within ${ATTACHMENT_DIR} (set ATTACHMENT_DIR to change)`
    );
  }
  return resolved;
}

function toLeanMessages(
  messages: EmailMessage[],
  opts: { includeFolder: boolean }
) {
  return messages.map(({ id, from, subject, date, snippet, folder }) => {
    const lean: Record<string, unknown> = { id, from, subject, date, snippet };
    if (opts.includeFolder) lean.folder = folder;
    return lean;
  });
}

function parseEmailFormat(): "plain" | "html" {
  const raw = (process.env.EMAIL_FORMAT ?? "plain").trim().toLowerCase();
  if (raw === "html") return "html";
  return "plain";
}

export function registerEmailTools(
  server: McpServer,
  backend: EmailBackend
): void {
  const disabled = parseDisabledTools();

  if (toolEnabled("list_folders", disabled)) {
    server.tool(
      "list_folders",
      "List all email folders/mailboxes",
      {},
      async () => {
        try {
          const folders = await backend.listFolders();
          return jsonResult(folders);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("list_messages", disabled)) {
    server.tool(
      "list_messages",
      "List recent email messages, optionally filtered by folder",
      {
        folder: z
          .string()
          .optional()
          .describe("Folder name to filter by (e.g. 'Inbox')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (default 25)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of messages to skip for pagination"),
        verbose: z
          .boolean()
          .optional()
          .describe("Return all fields (to, cc, isRead, folder) — default returns only id, from, subject, date, snippet"),
      },
      async ({ folder, limit, offset, verbose }) => {
        try {
          const messages = await backend.listMessages({ folder, limit, offset });
          if (verbose) return jsonResult(messages);
          return jsonResult(toLeanMessages(messages, { includeFolder: !folder }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("get_message", disabled)) {
    server.tool(
      "get_message",
      "Get a single email message by ID, including its full body text",
      {
        id: z.string().describe("The message ID"),
      },
      async ({ id }) => {
        try {
          const msg = await backend.getMessage(id);
          if (!msg) {
            return {
              content: [{ type: "text" as const, text: "Message not found" }],
              isError: true,
            };
          }
          return jsonResult(msg);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (toolEnabled("search_messages", disabled)) {
    server.tool(
      "search_messages",
      "Search email messages by text query",
      {
        query: z.string().describe("Search query text"),
        folder: z.string().optional().describe("Folder to search within"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default 25)"),
        verbose: z
          .boolean()
          .optional()
          .describe("Return all fields (to, cc, isRead, folder) — default returns only id, from, subject, date, snippet"),
      },
      async ({ query, folder, limit, verbose }) => {
        try {
          const messages = await backend.searchMessages({ query, folder, limit });
          if (verbose) return jsonResult(messages);
          return jsonResult(toLeanMessages(messages, { includeFolder: !folder }));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (backend.sendMessage && toolEnabled("send_message", disabled)) {
    const sendFn = backend.sendMessage.bind(backend);
    const emailFormat = parseEmailFormat();

    const sendParams: Record<string, z.ZodType> = {
      to: z.array(z.string()).describe("Recipient email addresses"),
      cc: z.array(z.string()).optional().describe("CC recipient email addresses"),
      bcc: z.array(z.string()).optional().describe("BCC recipient email addresses"),
      subject: z.string().describe("Email subject"),
      textBody: z.string().describe("Plain text body of the email"),
      inReplyTo: z
        .string()
        .optional()
        .describe("Message ID to reply to, for threading"),
    };

    if (emailFormat === "html") {
      sendParams.htmlBody = z
        .string()
        .describe("HTML body of the email. The message is sent as multipart with both plain text and HTML.");
    }

    server.tool(
      "send_message",
      "Send an email message",
      sendParams,
      async (args: Record<string, unknown>) => {
        try {
          const result = await sendFn({
            to: args.to as string[],
            cc: args.cc as string[] | undefined,
            bcc: args.bcc as string[] | undefined,
            subject: args.subject as string,
            textBody: args.textBody as string,
            htmlBody: args.htmlBody as string | undefined,
            inReplyTo: args.inReplyTo as string | undefined,
          });
          return jsonResult({ sent: true, id: result.id });
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  if (backend.getAttachment && toolEnabled("get_attachment", disabled)) {
    const getAttachmentFn = backend.getAttachment.bind(backend);

    server.tool(
      "get_attachment",
      "Download an email attachment by part ID (from get_message attachments list). Returns base64-encoded content, or saves to disk if saveTo is provided.",
      {
        id: z.string().describe("The message ID"),
        partId: z
          .string()
          .describe(
            "The attachment part ID (from the attachments array in get_message response)"
          ),
        saveTo: z
          .string()
          .optional()
          .describe(
            "File path to save attachment to disk instead of returning base64 content. Must be within ATTACHMENT_DIR (defaults to ~/Downloads)"
          ),
      },
      async ({ id, partId, saveTo }) => {
        try {
          const result = await getAttachmentFn(id, partId, MAX_ATTACHMENT_SIZE);
          if (saveTo) {
            const safePath = validateSavePath(saveTo);
            const buffer = Buffer.from(result.content, "base64");
            await mkdir(dirname(safePath), { recursive: true });
            await writeFile(safePath, buffer, { flag: "wx" });
            return jsonResult({
              saved: true,
              path: safePath,
              filename: result.filename,
              mimeType: result.mimeType,
              size: buffer.length,
            });
          }
          return jsonResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
