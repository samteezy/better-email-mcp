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

export interface ParsedBodyPart {
  partId: string;
  type: string;
  subtype: string;
  parameters: Record<string, string>;
  encoding: string;
  size: number;
  contentId: string | null;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  parts?: ParsedBodyPart[];
}

export interface ParsedFetch {
  uid?: number;
  flags?: string[];
  envelope?: ParsedEnvelope;
  bodyText?: string;
  bodyStructure?: ParsedBodyPart;
  bodyParts?: Map<string, string>;
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
    } else if (keyword === "BODYSTRUCTURE") {
      const { value, endIndex } = parseParenList(inner, i);
      result.bodyStructure = parseBodyStructure(value);
      i = endIndex;
    } else if (keyword.startsWith("BODY[")) {
      // Extract section name from BODY[section]
      const sectionMatch = keyword.match(/^BODY\[([^\]]*)\]$/);
      const section = sectionMatch ? sectionMatch[1] : "";
      const isPartSection = /^\d+(\.\d+)*$/.test(section);

      // Parse the value (literal, quoted, or atom)
      let bodyValue: string | undefined;
      if (inner[i] === '"') {
        const { value, endIndex } = parseQuotedString(inner, i);
        bodyValue = value;
        i = endIndex;
      } else if (inner[i] === "{") {
        const braceEnd = inner.indexOf("}", i);
        if (braceEnd !== -1) {
          const size = parseInt(inner.substring(i + 1, braceEnd), 10);
          const dataStart = braceEnd + 1;
          bodyValue = inner.substring(dataStart, dataStart + size);
          i = dataStart + size;
        }
      } else {
        const { value, endIndex } = parseAtom(inner, i);
        bodyValue = value === "NIL" ? undefined : value;
        i = endIndex;
      }

      if (isPartSection && bodyValue !== undefined) {
        if (!result.bodyParts) result.bodyParts = new Map();
        result.bodyParts.set(section, bodyValue);
      } else {
        result.bodyText = bodyValue;
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

// --- BODYSTRUCTURE parsing ---

/**
 * Parses a BODYSTRUCTURE paren list into a structured tree.
 *
 * RFC 3501 §7.4.2:
 * - Non-multipart body: (type subtype params bodyId description encoding size ...)
 *   followed by optional extension data (md5, disposition, language, location).
 * - Multipart body: ((part1)(part2)... subtype [params] [disposition] [language] [location])
 *
 * Part numbering: top-level parts are "1", "2", etc. Sub-parts within a
 * multipart are "1.1", "1.2", etc. A non-multipart message has a single part "1".
 */
export function parseBodyStructure(
  list: any[],
  partId?: string
): ParsedBodyPart {
  // Multipart: first element is an array (a child part)
  if (Array.isArray(list[0])) {
    return parseMultipartStructure(list, partId);
  }
  return parseSinglePartStructure(list, partId ?? "1");
}

function parseMultipartStructure(
  list: any[],
  parentPartId?: string
): ParsedBodyPart {
  const parts: ParsedBodyPart[] = [];
  let subtype = "mixed";
  let extensionStart = 0;

  // Collect child parts (arrays) until we hit a string (the subtype)
  for (let idx = 0; idx < list.length; idx++) {
    if (Array.isArray(list[idx])) {
      const childNum = parts.length + 1;
      const childId = parentPartId
        ? `${parentPartId}.${childNum}`
        : `${childNum}`;
      parts.push(parseBodyStructure(list[idx], childId));
    } else {
      // First non-array element is the subtype
      subtype =
        typeof list[idx] === "string" ? list[idx].toLowerCase() : "mixed";
      extensionStart = idx + 1;
      break;
    }
  }

  // Extension data after subtype: params, disposition, language, location
  const params = parseParamPairs(list[extensionStart]);
  const { disposition, dispositionParams } = parseDisposition(
    list[extensionStart + 1]
  );

  return {
    partId: parentPartId ?? "",
    type: "multipart",
    subtype,
    parameters: params,
    encoding: "7BIT",
    size: 0,
    contentId: null,
    disposition,
    dispositionParams,
    parts,
  };
}

function parseSinglePartStructure(
  list: any[],
  partId: string
): ParsedBodyPart {
  // (type subtype params bodyId description encoding size [lines]
  //  [md5] [disposition] [language] [location])
  const type =
    typeof list[0] === "string" ? list[0].toLowerCase() : "application";
  const subtype =
    typeof list[1] === "string" ? list[1].toLowerCase() : "octet-stream";
  const params = parseParamPairs(list[2]);
  const contentId =
    typeof list[3] === "string" ? list[3].replace(/[<>]/g, "") : null;
  // list[4] = description (unused)
  const encoding =
    typeof list[5] === "string" ? list[5].toUpperCase() : "7BIT";
  const size = typeof list[6] === "string" ? parseInt(list[6], 10) : 0;

  // For text/* parts, line count is at index 7, pushing extension data forward
  let extOffset = 7;
  if (type === "text") extOffset = 8;
  // For message/rfc822, envelope+body+lines occupy 7-9, pushing extension data to 10
  if (type === "message" && subtype === "rfc822") extOffset = 10;

  // Extension data: md5, disposition, language, location
  // md5 is at extOffset, disposition at extOffset+1
  const { disposition, dispositionParams } = parseDisposition(
    list[extOffset + 1]
  );

  return {
    partId,
    type,
    subtype,
    parameters: params,
    encoding,
    size: isNaN(size) ? 0 : size,
    contentId,
    disposition,
    dispositionParams,
  };
}

/** Parse IMAP parameter pairs: ("key" "value" "key2" "value2") → Record */
function parseParamPairs(data: any): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(data)) return result;
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (typeof data[i] === "string" && typeof data[i + 1] === "string") {
      result[data[i].toLowerCase()] = decodeRfc2047(data[i + 1]);
    }
  }
  return result;
}

/** Parse disposition: ("attachment" ("filename" "file.pdf")) or NIL */
function parseDisposition(
  data: any
): { disposition: string | null; dispositionParams: Record<string, string> } {
  if (!Array.isArray(data)) {
    return { disposition: null, dispositionParams: {} };
  }
  const disposition =
    typeof data[0] === "string" ? data[0].toLowerCase() : null;
  const dispositionParams = parseParamPairs(data[1]);
  return { disposition, dispositionParams };
}

/**
 * Extracts attachment info from a parsed body structure tree.
 * Returns non-inline attachments plus inline parts with a content-id (embedded images).
 */
export function flattenAttachments(
  part: ParsedBodyPart
): import("../types.js").AttachmentInfo[] {
  const attachments: import("../types.js").AttachmentInfo[] = [];
  collectAttachments(part, attachments);
  return attachments;
}

function collectAttachments(
  part: ParsedBodyPart,
  out: import("../types.js").AttachmentInfo[]
): void {
  if (part.parts) {
    for (const child of part.parts) {
      collectAttachments(child, out);
    }
    return;
  }

  // Skip multipart containers and plain text/html body parts (unless explicitly attached)
  if (part.type === "multipart") return;
  if (
    (part.type === "text" && (part.subtype === "plain" || part.subtype === "html")) &&
    part.disposition !== "attachment"
  ) {
    return;
  }

  const filename =
    part.dispositionParams.filename ||
    part.parameters.name ||
    `attachment-${part.partId}`;

  out.push({
    partId: part.partId,
    filename,
    mimeType: `${part.type}/${part.subtype}`,
    size: part.size,
    isInline: part.disposition === "inline" && part.contentId !== null,
  });
}

/**
 * Finds a specific part by ID in a body structure tree.
 */
export function findBodyPart(
  root: ParsedBodyPart,
  partId: string
): ParsedBodyPart | null {
  if (root.partId === partId) return root;
  if (root.parts) {
    for (const child of root.parts) {
      const found = findBodyPart(child, partId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Decodes MIME part content based on its transfer encoding.
 * Returns a Buffer of the decoded content.
 */
export function decodePartContent(data: string, encoding: string): Buffer {
  switch (encoding.toUpperCase()) {
    case "BASE64":
      return Buffer.from(data.replace(/\s/g, ""), "base64");
    case "QUOTED-PRINTABLE":
      return decodeQuotedPrintable(data);
    default:
      // 7BIT, 8BIT, BINARY — treat as raw
      return Buffer.from(data, "binary");
  }
}

/**
 * Decodes quoted-printable encoded content (RFC 2045).
 * Soft line breaks (=\r\n) are removed, =XX sequences decoded.
 */
export function decodeQuotedPrintable(data: string): Buffer {
  const cleaned = data.replace(/=\r?\n/g, "");
  const decoded = cleaned.replace(
    /=([0-9A-Fa-f]{2})/g,
    (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))
  );
  return Buffer.from(decoded, "binary");
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
