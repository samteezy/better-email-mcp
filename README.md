# better-email-mcp

An MCP server that gives LLM tools access to your email, calendar, tasks, and contacts — built to be the one you actually want to use.

## Why "better"?

- **Virtually zero dependencies.** The only runtime dependency is the MCP SDK itself. IMAP, SMTP, CalDAV, and CardDAV clients are implemented from scratch using Node built-ins — no third-party libraries in your supply chain.
- **Works with any provider.** Supports IMAP/SMTP (Gmail, Outlook, self-hosted, etc.), Fastmail JMAP (email + contacts), and any CalDAV/CardDAV server (Fastmail, iCloud, Nextcloud, Radicale, etc.) for calendars, tasks, and contacts.
- **You control what the LLM can do.** Disable any tool with a single environment variable — enforce read-only access, hide search, or strip it down to just what you need. Less tool clutter means better LLM performance.
- **Token-efficient.** List and search responses return only essential fields by default. Pass `verbose: true` for full details when needed.


### Token efficiency

All tool responses use compact JSON (no pretty-printing). List and search tools (`list_messages`, `search_messages`, `list_events`, `search_events`, `list_tasks`, `search_tasks`, `list_contacts`, `search_contacts`) return a lean field set by default — just enough to identify and triage each item. Pass `verbose: true` to get the full response with all fields.

**Tool definition token cost** (schema tokens consumed per request, estimated at ~3.5 chars/token):

| Configuration | Tools | Est. tokens |
|---------------|-------|-------------|
| Email only (IMAP or JMAP) | 6 | ~380 |
| Email + Calendar + Tasks | 16 | ~943 |
| Email + Contacts (JMAP) | 10 | ~585 |
| Full suite (JMAP + CalDAV + Contacts) | 20 | ~1,148 |

Run `npm run count-tokens` for a per-tool breakdown. Use `DISABLED_TOOLS` to trim tools you don't need.

**Default fields by tool type:**

| Tool type | Default fields | Additional with `verbose: true` |
|-----------|---------------|--------------------------------|
| Email list/search | `id`, `from`, `subject`, `date`, `snippet` | `to`, `cc`, `isRead`, `folder` |
| Calendar list/search | `id`, `href`, `title`, `start`, `end`, `location`, `allDay` | `description`, `organizer`, `attendees`, `status`, `recurrence`, `calendar` |
| Task list/search | `id`, `href`, `title`, `status`, `due`, `priority` | `description`, `categories`, `start`, `completed`, `percentComplete`, `recurrence`, `calendar` |
| Contact list/search | `id`, `href`, `name`, `emails`, `phones` | `organization`, `title`, `address`, `notes`, `addressBook` |

The `folder`, `calendar`, and `addressBook` fields are automatically included in lean responses when no filter is applied (listing across all), and omitted when filtering by a specific one (since it's redundant).

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

### CalDAV (calendar)

Calendar and task tools activate when `CALDAV_URL` is set. Works alongside any email backend. Tasks use CalDAV VTODO — supported by Fastmail, iCloud, Nextcloud, Radicale, and most CalDAV servers.

| Variable | Required | Description |
|----------|----------|-------------|
| `CALDAV_URL` | Yes | CalDAV principal or calendar-home URL |
| `CALDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CALDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CALDAV_DEFAULT_CALENDAR` | No | Default calendar name — when set, tools scope to this calendar automatically |

### Contacts

When using the JMAP backend, contact tools activate automatically via JMAP Contacts (RFC 9610) — no extra configuration needed. To use CardDAV instead (or with the IMAP backend), set `CARDDAV_URL`:

#### CardDAV (optional override)

| Variable | Required | Description |
|----------|----------|-------------|
| `CARDDAV_URL` | Yes | CardDAV principal or addressbook-home URL |
| `CARDDAV_USERNAME` | Yes | HTTP Basic auth username |
| `CARDDAV_PASSWORD` | Yes | HTTP Basic auth password |
| `CARDDAV_DEFAULT_ADDRESS_BOOK` | No | Default address book name — when set, tools scope to this book automatically |

### Disabling tools

Set `DISABLED_TOOLS` to a comma-separated list of tool names to prevent them from being registered:

```bash
DISABLED_TOOLS=send_message,search_messages
```

This is useful for enforcing read-only access or reducing context for the LLM. When using `CALDAV_DEFAULT_CALENDAR` or `CARDDAV_DEFAULT_ADDRESS_BOOK`, you can also disable `list_calendars` or `list_address_books` since the LLM no longer needs to discover them.

### Attachment downloads

The `get_attachment` tool supports a `saveTo` parameter that writes the file to disk instead of returning base64 content. For security, `saveTo` paths are restricted to a base directory:

```bash
ATTACHMENT_DIR=~/Downloads  # default; set to change the allowed directory
```

## Usage with MCP clients

### JMAP (Fastmail) — email + contacts

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

Contact tools are included automatically via JMAP — no CardDAV setup needed.

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

### JMAP + CalDAV (Fastmail, all features)

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["better-email-mcp"],
      "env": {
        "EMAIL_BACKEND": "jmap",
        "JMAP_TOKEN": "your-fastmail-api-token",
        "CALDAV_URL": "https://caldav.fastmail.com/",
        "CALDAV_USERNAME": "you@fastmail.com",
        "CALDAV_PASSWORD": "your-app-password"
      }
    }
  }
}
```

Email and contacts use JMAP (automatic), calendar uses CalDAV. To use CardDAV for contacts instead, set `CARDDAV_URL` (this overrides JMAP contacts).

## Tools

### Email

| Tool | Description |
|------|-------------|
| `list_folders` | List all email folders/mailboxes |
| `list_messages` | List recent messages with optional folder, limit, and offset |
| `get_message` | Get a single message by ID, including full body and attachment metadata |
| `search_messages` | Search messages by text query |
| `get_attachment` | Download an email attachment by part ID. Returns base64 content, or saves to disk if `saveTo` path is provided |
| `send_message` | Send an email (JMAP, or IMAP with SMTP configured) |

### Calendar (CalDAV)

| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars |
| `list_events` | List calendar events with optional calendar filter and limit |
| `get_event` | Get a single event by href, including full details |
| `search_events` | Search events by text query (matches title, description, location) |

### Tasks (CalDAV VTODO)

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks with optional calendar, status filter, and limit |
| `get_task` | Get a single task by href, including full details |
| `search_tasks` | Search tasks by text query (matches title, description, categories) |
| `create_task` | Create a new task with title, due date, priority, categories |
| `update_task` | Update an existing task's fields |
| `complete_task` | Mark a task as completed |

### Contacts (CardDAV)

| Tool | Description |
|------|-------------|
| `list_address_books` | List all address books |
| `list_contacts` | List contacts with optional address book filter and limit |
| `get_contact` | Get a single contact by href, including full details |
| `search_contacts` | Search contacts by name, email, phone, or organization |