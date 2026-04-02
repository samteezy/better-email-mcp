/**
 * Targeted XML parser for WebDAV multistatus responses.
 * Not a general-purpose XML parser — handles only the DAV:multistatus structure
 * used by CalDAV and CardDAV servers.
 */

export interface DavResponseEntry {
  href: string;
  props: Map<string, string>;
  status?: string;
}

/** Strip namespace prefix from a tag name (e.g. "d:href" → "href") */
function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.substring(i + 1) : tag;
}

/** Extract all top-level child elements from an XML fragment, returning tag + inner content */
function extractChildren(xml: string): Array<{ tag: string; content: string }> {
  const results: Array<{ tag: string; content: string }> = [];
  // Match opening tags, then find their corresponding closing tags
  const openTagRe = /<([a-zA-Z][a-zA-Z0-9:._-]*)\b[^>]*?(?:\/>|>)/g;
  let match;
  while ((match = openTagRe.exec(xml)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1];

    // Self-closing tag
    if (fullMatch.endsWith("/>")) {
      results.push({ tag: localName(tagName), content: "" });
      continue;
    }

    // Find the matching close tag, handling nesting
    const startPos = match.index + fullMatch.length;
    const closeTag = `</${tagName}>`;
    // Also match close tags with different prefix but same local name
    const localTag = localName(tagName);
    let depth = 1;
    let pos = startPos;
    while (depth > 0 && pos < xml.length) {
      const nextOpen = xml.indexOf(`<${tagName}`, pos);
      // Find close tag by local name (handles namespace prefix variations)
      let nextClose = -1;
      const closeRe = new RegExp(`<\\/[a-zA-Z0-9]*:?${escapeRegex(localTag)}>`, "g");
      closeRe.lastIndex = pos;
      const closeMatch = closeRe.exec(xml);
      if (closeMatch) nextClose = closeMatch.index;

      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // Check if it's a self-closing variant
        const tagEnd = xml.indexOf(">", nextOpen);
        if (tagEnd !== -1 && xml[tagEnd - 1] === "/") {
          pos = tagEnd + 1;
          continue;
        }
        depth++;
        pos = nextOpen + 1;
      } else {
        depth--;
        if (depth === 0) {
          const content = xml.substring(startPos, nextClose);
          results.push({ tag: localTag, content: content.trim() });
        }
        pos = nextClose + closeTag.length;
      }
    }
  }
  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract text content of a specific element by local tag name */
export function extractText(xml: string, tagLocalName: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${escapeRegex(tagLocalName)}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${escapeRegex(tagLocalName)}>`,
    "i"
  );
  const m = re.exec(xml);
  return m ? m[1].trim() : undefined;
}

/** Extract all matching elements' text content by local tag name */
export function extractAllText(xml: string, tagLocalName: string): string[] {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${escapeRegex(tagLocalName)}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${escapeRegex(tagLocalName)}>`,
    "gi"
  );
  const results: string[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

/** Check if an XML fragment contains a specific self-closing or empty element by local tag name */
export function hasElement(xml: string, tagLocalName: string): boolean {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${escapeRegex(tagLocalName)}\\b[^>]*?\\/?>`,
    "i"
  );
  return re.test(xml);
}

/**
 * Parse a WebDAV multistatus XML response into structured entries.
 * Handles namespace prefix variations across servers.
 */
export function parseMultistatus(xml: string): DavResponseEntry[] {
  const entries: DavResponseEntry[] = [];

  // Extract all <response> blocks (with any namespace prefix)
  const responseRe =
    /<(?:[a-zA-Z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?response>/gi;
  let responseMatch;

  while ((responseMatch = responseRe.exec(xml)) !== null) {
    const responseBlock = responseMatch[1];

    const href = extractText(responseBlock, "href");
    if (!href) continue;

    const entry: DavResponseEntry = {
      href,
      props: new Map(),
    };

    // Find propstat blocks
    const propstatRe =
      /<(?:[a-zA-Z0-9]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?propstat>/gi;
    let propstatMatch;

    while ((propstatMatch = propstatRe.exec(responseBlock)) !== null) {
      const propstatBlock = propstatMatch[1];

      // Check status — only process 200 OK propstats
      const status = extractText(propstatBlock, "status");
      if (status && !status.includes("200")) continue;

      entry.status = status;

      // Extract the <prop> block
      const propBlock = extractText(propstatBlock, "prop");
      if (!propBlock) continue;

      // Extract each child element of <prop>
      const children = extractChildren(propBlock);
      for (const child of children) {
        entry.props.set(child.tag, child.content);
      }
    }

    entries.push(entry);
  }

  return entries;
}
