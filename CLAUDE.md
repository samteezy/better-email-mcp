# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`better-email-mcp` is a Model Context Protocol (MCP) server that exposes email access to LLM tools (e.g. Claude). It supports two backends:

- **IMAP** — generic email access for any IMAP-compatible provider
- **JMAP** — Fastmail's native JMAP API for richer, more efficient access

The goal is a well-designed, opinionated MCP server that goes beyond existing solutions — prioritizing good tool ergonomics for LLMs, not just raw protocol exposure.

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

## Architecture

The server is organized around two layers:

1. **Backend adapters** (`src/backends/`) — one for IMAP and one for JMAP. Each implements the `EmailBackend` interface defined in `src/types.ts`, so the MCP tool layer is backend-agnostic.

2. **MCP tool layer** (`src/tools/`) — registers MCP tools (e.g. `list_messages`, `get_message`, `search`) that delegate to whichever backend is configured. Tool inputs and outputs are designed for LLM usability: concise, structured, and avoiding raw MIME blobs where possible.

Entry point is `src/index.ts` — creates the `McpServer`, registers tools, and connects via stdio transport.

Backend is selected at startup via environment variables — not at tool-call time.

## Key Design Principles

- **LLM-first tool design**: tool schemas and return values should be easy for a model to reason about. Prefer structured fields (sender, subject, date, snippet) over raw RFC 2822 output.
- **Single backend per server instance**: don't try to multiplex IMAP and JMAP in one running server. Run two instances if needed.
- **Credentials via environment**: `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `JMAP_TOKEN`, etc. Never bake credentials into config files committed to the repo.
- **Minimal dependencies**: prefer well-maintained, narrowly-scoped libraries for IMAP/JMAP over large framework solutions.
