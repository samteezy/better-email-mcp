import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JmapBackend } from "./backends/jmap.js";
import { ImapBackend } from "./backends/imap.js";
import { registerEmailTools } from "./tools/register.js";
import { EmailBackend } from "./types.js";

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
    return new ImapBackend({
      host,
      port: parseInt(process.env.IMAP_PORT ?? "993", 10),
      user,
      password,
      tls: process.env.IMAP_TLS !== "false",
    });
  }

  throw new Error(`Unknown backend: ${backendType}`);
}

const server = new McpServer({
  name: "better-email-mcp",
  version: "0.1.0",
});

const backend = createBackend();
registerEmailTools(server, backend);

async function main() {
  await backend.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
