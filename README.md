# better-email-mcp

An MCP server that gives LLM tools access to your email — built to be the one you actually want to use.

## Why "better"?

- **Virtually zero dependencies.** The only runtime dependency is the MCP SDK itself. The IMAP and SMTP clients are implemented from scratch using Node's built-in `net`/`tls` modules — no third-party email libraries in your supply chain.
- **Works with any email provider.** Supports both IMAP/SMTP (Gmail, Outlook, self-hosted, etc.) and Fastmail's JMAP API, so you're not locked into one provider.
- **You control what the LLM can do.** Disable any tool with a single environment variable — enforce read-only access, hide search, or strip it down to just what you need. Less tool clutter means better LLM performance.

## Setup

Install and run directly with npx — no clone needed:

```bash
npx better-email-mcp
```

Or install globally:

```bash
npm install -g better-email-mcp
```

For local development:

```bash
git clone https://github.com/samteezy/better-email-mcp.git
cd better-email-mcp
npm install
npm run build
```

## Configuration

The server is configured entirely through environment variables.

### Backend selection

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_BACKEND` | `"jmap"` or `"imap"` | `"jmap"` |
| `EMAIL_FORMAT` | `"plain"` or `"html"` | `"plain"` |

When set to `html`, the `send_message` tool requires an `htmlBody` field in addition to `textBody`, and messages are sent as multipart with both plain text and HTML. When set to `plain` (the default), only `textBody` is exposed — the LLM cannot generate HTML email.

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

### SMTP (sending from IMAP)

To enable sending with the IMAP backend, configure an SMTP server:

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | No | SMTP server hostname (e.g. `smtp.gmail.com`). Enables sending. |
| `SMTP_PORT` | No | Server port (default: `587`). Use `465` for implicit TLS. |
| `SMTP_USER` | When `SMTP_HOST` set | SMTP login username |
| `SMTP_PASSWORD` | When `SMTP_HOST` set | SMTP login password |
| `SMTP_TLS` | No | Enable TLS (default: `true`). Port 465 uses implicit TLS; port 587 uses STARTTLS. |
| `SMTP_FROM` | No | Sender address (defaults to `SMTP_USER`) |

If `SMTP_HOST` is not set, the IMAP backend is read-only and the `send_message` tool is not registered.

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
      "command": "npx",
      "args": ["better-email-mcp"],
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
      "command": "npx",
      "args": ["better-email-mcp"],
      "env": {
        "EMAIL_BACKEND": "imap",
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "you@example.com",
        "IMAP_PASSWORD": "your-password",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_USER": "you@example.com",
        "SMTP_PASSWORD": "your-password"
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
| `send_message` | Send an email (JMAP, or IMAP with SMTP configured) |
