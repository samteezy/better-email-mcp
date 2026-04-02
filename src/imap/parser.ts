/**
 * IMAP response parser.
 *
 * Handles tagged/untagged responses, parenthesized lists (flags, envelopes,
 * body structures), and RFC 2047 encoded-word decoding.
 */

// --- Types ---

export interface ImapResponse {
  tag: string; // "*" for untagged, "+" for continuation, or "A1" etc.
  type?: string; // "OK", "NO", "BAD", "EXISTS", "FETCH", "SEARCH", "LIST", etc.
  num?: number; // message number if present (e.g. "* 5 EXISTS" → 5)
  text: string; // raw text after tag+type+num
}

export interface ImapAddress {
  name: string;
  email: string;
}

export interface ParsedEnvelope {
  date: string;
  subject: string;
  from: ImapAddress[];
  sender: ImapAddress[];
  replyTo: ImapAddress[];
  to: ImapAddress[];
  cc: ImapAddress[];
  bcc: ImapAddress[];
  inReplyTo: string;
  messageId: string;
}

export interface ParsedFetch {
  uid?: number;
  flags?: string[];
  envelope?: ParsedEnvelope;
  bodyText?: string;
}

// --- Response line parsing ---

export function parseResponseLine(line: string): ImapResponse {
  // Continuation response
  if (line.startsWith("+ ") || line === "+") {
    return { tag: "+", text: line.substring(2) };
  }

  // Untagged response: * ...
  if (line.startsWith("* ")) {
    return parseUntagged(line.substring(2));
  }

  // Tagged response: A1 OK/NO/BAD ...
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) {
    return { tag: line, text: "" };
  }
  const tag = line.substring(0, spaceIdx);
  const rest = line.substring(spaceIdx + 1);

  const typeMatch = rest.match(/^(OK|NO|BAD)\b\s*(.*)/i);
  if (typeMatch) {
    return {
      tag,
      type: typeMatch[1].toUpperCase(),
      text: typeMatch[2],
    };
  }

  return { tag, text: rest };
}

function parseUntagged(rest: string): ImapResponse {
  // Check for numeric prefix: "* 5 EXISTS", "* 42 FETCH (...)"
  const numMatch = rest.match(/^(\d+)\s+(\S+)\s*(.*)/);
  if (numMatch) {
    return {
      tag: "*",
      num: parseInt(numMatch[1], 10),
      type: numMatch[2].toUpperCase(),
      text: numMatch[3],
    };
  }

  // Non-numeric: "* OK ...", "* SEARCH 1 4 9", "* LIST ..."
  const typeMatch = rest.match(/^(\S+)\s*(.*)/);
  if (typeMatch) {
    return {
      tag: "*",
      type: typeMatch[1].toUpperCase(),
      text: typeMatch[2],
    };
  }

  return { tag: "*", text: rest };
}

// --- Parenthesized list parser ---

/**
 * Parses an IMAP parenthesized list into a nested array.
 * Handles NIL, quoted strings, literals (as pre-substituted text), and atoms.
 *
 * Example: `(\\Seen \\Flagged)` → ["\\Seen", "\\Flagged"]
 * Example: `("hello" NIL)` → ["hello", null]
 */
export function parseParenList(data: string, startIndex = 0): { value: any[]; endIndex: number } {
  const result: any[] = [];
  let i = startIndex;

  // Skip leading whitespace
  while (i < data.length && data[i] === " ") i++;

  if (data[i] !== "(") {
    throw new Error(`Expected '(' at position ${i}, got '${data[i]}'`);
  }
  i++; // skip opening paren

  while (i < data.length) {
    // Skip whitespace
    while (i < data.length && data[i] === " ") i++;

    if (i >= data.length) break;

    const ch = data[i];

    if (ch === ")") {
      return { value: result, endIndex: i + 1 };
    }

    if (ch === "(") {
      // Nested list
      const nested = parseParenList(data, i);
      result.push(nested.value);
      i = nested.endIndex;
    } else if (ch === '"') {
      // Quoted string
      const { value, endIndex } = parseQuotedString(data, i);
      result.push(value);
      i = endIndex;
    } else {
      // Atom or NIL
      const { value, endIndex } = parseAtom(data, i);
      result.push(value === "NIL" ? null : value);
      i = endIndex;
    }
  }

  return { value: result, endIndex: i };
}

function parseQuotedString(data: string, startIndex: number): { value: string; endIndex: number } {
  let i = startIndex + 1; // skip opening quote
  let result = "";

  while (i < data.length) {
    if (data[i] === "\\") {
      // Escaped character
      i++;
      if (i < data.length) {
        result += data[i];
        i++;
      }
    } else if (data[i] === '"') {
      return { value: result, endIndex: i + 1 };
    } else {
      result += data[i];
      i++;
    }
  }

  return { value: result, endIndex: i };
}

function parseAtom(data: string, startIndex: number): { value: string; endIndex: number } {
  let i = startIndex;
  while (i < data.length && data[i] !== " " && data[i] !== ")" && data[i] !== "(") {
    i++;
  }
  return { value: data.substring(startIndex, i), endIndex: i };
}

// --- FETCH response parsing ---

/**
 * Parses the data items from a FETCH response.
 * Input: the text after "* N FETCH", e.g. "(UID 42 FLAGS (\\Seen) ENVELOPE (...))"
 */
export function parseFetchResponse(text: string): ParsedFetch {
  const result: ParsedFetch = {};

  // Strip outer parens
  const trimmed = text.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return result;
  }
  const inner = trimmed.substring(1, trimmed.length - 1);

  let i = 0;
  while (i < inner.length) {
    // Skip whitespace
    while (i < inner.length && inner[i] === " ") i++;
    if (i >= inner.length) break;

    // Read keyword
    const kwStart = i;
    while (i < inner.length && inner[i] !== " " && inner[i] !== "(") i++;
    const keyword = inner.substring(kwStart, i).toUpperCase();

    // Skip whitespace
    while (i < inner.length && inner[i] === " ") i++;

    if (keyword === "UID") {
      const { value, endIndex } = parseAtom(inner, i);
      result.uid = parseInt(value, 10);
      i = endIndex;
    } else if (keyword === "FLAGS") {
      const { value, endIndex } = parseParenList(inner, i);
      result.flags = value as string[];
      i = endIndex;
    } else if (keyword === "ENVELOPE") {
      const { value, endIndex } = parseParenList(inner, i);
      result.envelope = mapEnvelopeList(value);
      i = endIndex;
    } else if (keyword.startsWith("BODY[")) {
      // Body text: BODY[TEXT] or BODY[1] etc.
      // Value follows as a literal or quoted string
      if (inner[i] === '"') {
        const { value, endIndex } = parseQuotedString(inner, i);
        result.bodyText = value;
        i = endIndex;
      } else if (inner[i] === "{") {
        // Literal: {N}\r\n<data> — in our usage, literals are pre-joined by the client
        // so this appears as {N} followed by the data after client processing
        const braceEnd = inner.indexOf("}", i);
        if (braceEnd !== -1) {
          const size = parseInt(inner.substring(i + 1, braceEnd), 10);
          // Data follows after the closing brace (client pre-processes \r\n)
          const dataStart = braceEnd + 1;
          result.bodyText = inner.substring(dataStart, dataStart + size);
          i = dataStart + size;
        }
      } else {
        const { value, endIndex } = parseAtom(inner, i);
        result.bodyText = value === "NIL" ? undefined : value;
        i = endIndex;
      }
    } else {
      // Skip unknown data item value
      if (i < inner.length && inner[i] === "(") {
        const { endIndex } = parseParenList(inner, i);
        i = endIndex;
      } else if (i < inner.length && inner[i] === '"') {
        const { endIndex } = parseQuotedString(inner, i);
        i = endIndex;
      } else if (i < inner.length) {
        const { endIndex } = parseAtom(inner, i);
        i = endIndex;
      }
    }
  }

  return result;
}

// --- Envelope parsing ---

/**
 * Maps a parsed parenthesized list (from ENVELOPE) to a ParsedEnvelope.
 * RFC 3501 §7.4.2: (date subject from sender reply-to to cc bcc in-reply-to message-id)
 */
function mapEnvelopeList(list: any[]): ParsedEnvelope {
  return {
    date: typeof list[0] === "string" ? list[0] : "",
    subject: typeof list[1] === "string" ? decodeRfc2047(list[1]) : "",
    from: parseAddressList(list[2]),
    sender: parseAddressList(list[3]),
    replyTo: parseAddressList(list[4]),
    to: parseAddressList(list[5]),
    cc: parseAddressList(list[6]),
    bcc: parseAddressList(list[7]),
    inReplyTo: typeof list[8] === "string" ? list[8] : "",
    messageId: typeof list[9] === "string" ? list[9] : "",
  };
}

/**
 * Parses IMAP address list: ((name adl mailbox host) ...)
 * Each address is (personal-name at-domain-list mailbox host)
 * Email = mailbox@host, display name = personal-name
 */
function parseAddressList(data: any): ImapAddress[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((addr: any) => Array.isArray(addr))
    .map((addr: any[]) => {
      const name = typeof addr[0] === "string" ? decodeRfc2047(addr[0]) : "";
      const mailbox = typeof addr[2] === "string" ? addr[2] : "";
      const host = typeof addr[3] === "string" ? addr[3] : "";
      const email = host ? `${mailbox}@${host}` : mailbox;
      return { name, email };
    });
}

// --- SEARCH response parsing ---

/**
 * Parses UIDs from a SEARCH response text.
 * Input: "1 4 9 23" → [1, 4, 9, 23]
 */
export function parseSearchResponse(text: string): number[] {
  if (!text.trim()) return [];
  return text
    .trim()
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

// --- LIST response parsing ---

/**
 * Parses a LIST response line.
 * Format: (flags) "delimiter" "mailbox-name"
 * Input text (after "* LIST"): `(\HasNoChildren) "/" "INBOX"`
 */
export function parseListResponse(text: string): { flags: string[]; delimiter: string; name: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("(")) return null;

  // Parse flags
  const { value: flags, endIndex } = parseParenList(trimmed, 0);

  let i = endIndex;
  while (i < trimmed.length && trimmed[i] === " ") i++;

  // Parse delimiter (quoted string or NIL)
  let delimiter = "/";
  if (trimmed[i] === '"') {
    const { value, endIndex: dEnd } = parseQuotedString(trimmed, i);
    delimiter = value;
    i = dEnd;
  } else {
    const { value, endIndex: dEnd } = parseAtom(trimmed, i);
    delimiter = value === "NIL" ? "" : value;
    i = dEnd;
  }

  while (i < trimmed.length && trimmed[i] === " ") i++;

  // Parse mailbox name (quoted string or atom)
  let name = "";
  if (trimmed[i] === '"') {
    const { value } = parseQuotedString(trimmed, i);
    name = value;
  } else {
    const { value } = parseAtom(trimmed, i);
    name = value;
  }

  return { flags: flags as string[], delimiter, name };
}

// --- RFC 2047 encoded-word decoding ---

/**
 * Decodes RFC 2047 encoded words in a string.
 * Format: =?charset?encoding?encoded-text?=
 * Supports B (base64) and Q (quoted-printable) encodings.
 */
export function decodeRfc2047(input: string): string {
  if (!input || !input.includes("=?")) return input;

  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, _charset: string, encoding: string, encoded: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          return Buffer.from(encoded, "base64").toString("utf-8");
        }
        if (encoding.toUpperCase() === "Q") {
          // Quoted-printable: _ = space, =XX = hex byte
          const decoded = encoded
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
              String.fromCharCode(parseInt(hex, 16))
            );
          return Buffer.from(decoded, "binary").toString("utf-8");
        }
      } catch {
        // Fall through to return original
      }
      return encoded;
    }
  );
}
