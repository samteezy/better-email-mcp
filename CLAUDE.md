# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`better-email-mcp` is an MCP server that gives LLMs access to email, calendar, tasks, and contacts. See **[README.md](README.md)** for the authoritative reference on supported backends, configuration, available tools, and usage examples. Keep the README updated when adding or changing user-facing behavior.

High-level capabilities:

- **Email** — IMAP/SMTP (any provider) or Fastmail JMAP
- **Calendar** — CalDAV (Fastmail, iCloud, Nextcloud, Radicale, etc.)
- **Tasks** — CalDAV VTODO (same providers as calendar)
- **Contacts** — CardDAV (same providers)

CalDAV, CardDAV, and tasks activate alongside whichever email backend is configured — it's one server instance with all protocols combined.

## Tech Stack

- **TypeScript** on Node.js, compiled with `tsc`
- **npm** for package management
- **MCP SDK**: `@modelcontextprotocol/sdk` — uses `McpServer` with `StdioServerTransport`
- **Zod** for input validation on MCP tool schemas
- **Jest** with `ts-jest` for testing

## Commands

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Build (watch) | `npm run dev` |
| Run server | `npm start` |
| Run all tests | `npm test` |
| Run single test | `npx jest path/to/file.test.ts` |
| Watch tests | `npm run test:watch` |
| Lint | `npm run lint` |
| Type-check only | `npm run typecheck` |
| Count tool tokens | `npm run count-tokens` |

## Architecture

Entry point is `src/index.ts` — creates the `McpServer`, registers tools, and connects via stdio transport.

1. **Email backend adapters** (`src/backends/`) — IMAP and JMAP backends, each implementing the `EmailBackend` interface defined in `src/types.ts`, so the MCP tool layer is backend-agnostic. Backend is selected at startup via `EMAIL_BACKEND` env var.

2. **IMAP client** (`src/imap/`) — zero-dependency IMAP implementation using Node's built-in `net`/`tls` modules. `parser.ts` handles IMAP response parsing (parenthesized lists, envelopes, RFC 2047 decoding). `client.ts` manages the TCP/TLS connection with tagged command/response handling and literal string support. IMAP message IDs use composite `folder:uid` format (e.g. `INBOX:4523`) since UIDs are only unique within a mailbox. Sending requires SMTP configuration (IMAP itself is read-only).

3. **CalDAV / CardDAV clients** — calendar and contact access, activated when their respective env vars are set. Work alongside any email backend in a single server instance.

4. **MCP tool layer** (`src/tools/`) — registers MCP tools that delegate to the configured backends. Tool inputs and outputs are designed for LLM usability: concise, structured, and avoiding raw protocol output where possible.

## Key Design Principles

- **LLM-first tool design**: tool schemas and return values should be easy for a model to reason about. Prefer structured fields over raw protocol output.
- **Single email backend per instance**: don't multiplex IMAP and JMAP in one running server. CalDAV and CardDAV do run alongside the email backend in the same instance.
- **Credentials via environment**: never bake credentials into config files committed to the repo. See README for the full env var reference.
- **Zero/minimal dependencies**: implement protocol clients from scratch using Node built-ins (`net`/`tls`) to minimize supply chain attack surface. Avoid adding npm packages when the functionality can be implemented with reasonable effort.
- **User-disablable tools**: `DISABLED_TOOLS` env var prevents specific tools from being registered. See README for details.

## Versioning

Version lives in two places — `package.json` and the `McpServer` constructor in `src/index.ts`. Both must be updated together.

- **Minor bump** (0.4.0 → 0.5.0): new features, new tools, new capabilities.
- **Patch bump** (0.4.0 → 0.4.1): bug fixes, refactors, documentation-only changes.
- If unclear whether a change is a feature or a fix, ask the user before bumping.

## Token cost table

`README.md` has a "Tool definition token cost" table in the Token efficiency section. Keep it updated when tools are added, removed, or renamed. Run `npm run count-tokens` to regenerate the numbers — it builds the project, loads the actual tool registrations with mock backends, and prints per-tool and per-configuration estimates (~3.5 chars/token heuristic for BPE on JSON Schema). The script lives at `scripts/count-tool-tokens.js`.
