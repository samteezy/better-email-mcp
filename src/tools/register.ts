import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EmailBackend } from "../types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function registerEmailTools(
  server: McpServer,
  backend: EmailBackend
): void {
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
    },
    async ({ folder, limit, offset }) => {
      try {
        const messages = await backend.listMessages({ folder, limit, offset });
        return jsonResult(messages);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

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
    },
    async ({ query, folder, limit }) => {
      try {
        const messages = await backend.searchMessages({ query, folder, limit });
        return jsonResult(messages);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  if (backend.sendMessage) {
    const sendFn = backend.sendMessage.bind(backend);
    server.tool(
      "send_message",
      "Send an email message",
      {
        to: z.array(z.string()).describe("Recipient email addresses"),
        subject: z.string().describe("Email subject"),
        textBody: z.string().describe("Plain text body of the email"),
        inReplyTo: z
          .string()
          .optional()
          .describe("Message ID to reply to, for threading"),
      },
      async ({ to, subject, textBody, inReplyTo }) => {
        try {
          const result = await sendFn({ to, subject, textBody, inReplyTo });
          return jsonResult({ sent: true, id: result.id });
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
