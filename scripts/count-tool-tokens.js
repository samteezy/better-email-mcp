#!/usr/bin/env node
/**
 * Estimates the context-window token cost of all MCP tool definitions.
 *
 * Run after build:  npm run count-tokens
 *
 * Creates a mock McpServer that captures tool() calls, converts Zod schemas
 * to JSON Schema (same as the MCP SDK does), then counts characters and
 * estimates tokens (~3.5 chars/token for JSON with BPE).
 */

"use strict";

const { zodToJsonSchema } = require("zod-to-json-schema");
const { registerEmailTools } = require("../dist/tools/register.js");
const { registerCalendarTools } = require("../dist/tools/calendar.js");
const { registerTaskTools } = require("../dist/tools/tasks.js");
const { registerContactTools } = require("../dist/tools/contacts.js");

// ── Mock McpServer ───────────────────────────────────────────────────────

function createCapturingServer() {
  const tools = [];

  const server = {
    tool(name, description, schema, _handler) {
      const jsonProps = {};
      const required = [];

      for (const [key, val] of Object.entries(schema)) {
        const jsonSchema = zodToJsonSchema(val, { target: "openApi3" });
        delete jsonSchema.$schema;
        jsonProps[key] = jsonSchema;

        // Detect required (not ZodOptional)
        if (val._def?.typeName !== "ZodOptional") {
          required.push(key);
        }
      }

      const inputSchema = { type: "object", properties: jsonProps };
      if (required.length > 0) inputSchema.required = required;

      tools.push({ name, description, inputSchema });
    },
  };

  return { server, tools };
}

// ── Mock backends ────────────────────────────────────────────────────────

const noop = async () => { throw new Error("mock"); };
const noopArr = async () => [];
const noopNull = async () => null;

const emailBackend = {
  connect: noop, disconnect: noop,
  listFolders: noopArr, listMessages: noopArr,
  getMessage: noopNull, searchMessages: noopArr,
  sendMessage: noop, getAttachment: noop,
};

const calendarBackend = {
  connect: noop, listCalendars: noopArr,
  listEvents: noopArr, getEvent: noopNull, searchEvents: noopArr,
  listTasks: noopArr, getTask: noopNull, searchTasks: noopArr,
  createTask: noop, updateTask: noop, completeTask: noop,
};

const contactsBackend = {
  connect: noop, listAddressBooks: noopArr,
  listContacts: noopArr, getContact: noopNull, searchContacts: noopArr,
};

// ── Token estimation ─────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(jsonStr) {
  return Math.round(jsonStr.length / CHARS_PER_TOKEN);
}

// ── Configurations ───────────────────────────────────────────────────────

const configs = [
  { label: "Email only (IMAP or JMAP)", email: true, calendar: false, tasks: false, contacts: false },
  { label: "Email + Calendar + Tasks (e.g. IMAP + CalDAV)", email: true, calendar: true, tasks: true, contacts: false },
  { label: "Email + Contacts (JMAP)", email: true, calendar: false, tasks: false, contacts: true },
  { label: "Full suite (JMAP + CalDAV + Contacts)", email: true, calendar: true, tasks: true, contacts: true },
];

// ── Main ─────────────────────────────────────────────────────────────────

// Include htmlBody param (Fastmail JMAP with EMAIL_FORMAT=html)
process.env.EMAIL_FORMAT = "html";
delete process.env.DISABLED_TOOLS;

console.log("# MCP Tool Token Estimates\n");
console.log("Estimated using ~3.5 chars/token (BPE on JSON Schema).\n");

for (const config of configs) {
  const { server, tools } = createCapturingServer();

  if (config.email) registerEmailTools(server, emailBackend);
  if (config.calendar) registerCalendarTools(server, calendarBackend);
  if (config.tasks) registerTaskTools(server, calendarBackend);
  if (config.contacts) registerContactTools(server, contactsBackend);

  const totalJson = JSON.stringify(tools);
  const totalTokens = estimateTokens(totalJson);

  console.log(`## ${config.label}`);
  console.log(`Tools: ${tools.length} | Estimated tokens: ~${totalTokens.toLocaleString()}\n`);

  const maxNameLen = Math.max(...tools.map(t => t.name.length));
  for (const tool of tools) {
    const json = JSON.stringify(tool);
    const tokens = estimateTokens(json);
    console.log(`  ${tool.name.padEnd(maxNameLen)}  ${String(tokens).padStart(4)} tokens`);
  }
  console.log();
}

// Per-group breakdown for full suite
{
  const { server: s1, tools: emailTools } = createCapturingServer();
  registerEmailTools(s1, emailBackend);

  const { server: s2, tools: calTools } = createCapturingServer();
  registerCalendarTools(s2, calendarBackend);

  const { server: s3, tools: taskTools } = createCapturingServer();
  registerTaskTools(s3, calendarBackend);

  const { server: s4, tools: contactTools } = createCapturingServer();
  registerContactTools(s4, contactsBackend);

  console.log("## Group summary (full suite)\n");
  const groups = [
    { label: "Email", tools: emailTools },
    { label: "Calendar", tools: calTools },
    { label: "Tasks", tools: taskTools },
    { label: "Contacts", tools: contactTools },
  ];

  let grandTotal = 0;
  for (const g of groups) {
    const json = JSON.stringify(g.tools);
    const tokens = estimateTokens(json);
    grandTotal += tokens;
    console.log(`  ${g.label.padEnd(10)} ${g.tools.length} tools  ~${String(tokens).padStart(5)} tokens`);
  }
  console.log(`  ${"Total".padEnd(10)} ${groups.reduce((s, g) => s + g.tools.length, 0)} tools  ~${String(grandTotal).padStart(5)} tokens`);
}
