# better-email-mcp

An MCP server that gives LLM tools access to your email. Supports two backends:

- **JMAP** — Fastmail's native API for fast, full-featured access (including sending)
- **IMAP** — works with any IMAP-compatible email provider (read-only)

## Setup

```bash
npm install
npm run build
```

## Configuration

The server is configured entirely through environment variables.

### Backend selection

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_BACKEND` | `"jmap"` or `"imap"` | `"jmap"` |

### JMAP (Fastmail)

| Variable | Required | Description |
|----------|----------|-------------|
| `JMAP_TOKEN` | Yes | Fastmail API token |
| `JMAP_SESSION_URL` | No | JMAP session URL (default: `https://api.fastmail.com/.well-known/jmap`) |

To get a token, go to Fastmail **Settings > Privacy & Security > API tokens** and create a token with the email scopes you need.

### IMAP

| Variable | Required | Description |
|----------|----------|-------------|
| `IMAP_HOST` | Yes | IMAP server hostname (e.g. `imap.gmail.com`) |
| `IMAP_USER` | Yes | Login username |
| `IMAP_PASSWORD` | Yes | Login password or app-specific password |
| `IMAP_PORT` | No | Server port (default: `993`) |
| `IMAP_TLS` | No | Use TLS (default: `true`) |

> **Note:** The IMAP backend is read-only. Sending email requires SMTP, which is not implemented — use the JMAP backend if you need to send.

### Disabling tools

Set `DISABLED_TOOLS` to a comma-separated list of tool names to prevent them from being registered:

```bash
DISABLED_TOOLS=send_message,search_messages
```

This is useful for enforcing read-only access or reducing context for the LLM.

## Usage with MCP clients

### JMAP (Fastmail)

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/better-email-mcp/dist/index.js"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token"
      }
    }
  }
}
```

### IMAP

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/better-email-mcp/dist/index.js"],
      "env": {
        "EMAIL_BACKEND": "imap",
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-password"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_folders` | List all email folders/mailboxes |
| `list_messages` | List recent messages with optional folder, limit, and offset |
| `get_message` | Get a single message by ID, including full body |
| `search_messages` | Search messages by text query |
| `send_message` | Send an email (JMAP only) |
