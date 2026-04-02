/**
 * Zero-dependency vCard parser supporting v3.0 and v4.0 formats.
 * Parses vCard text into structured contact objects suitable for LLM consumption.
 */

export interface ParsedVCard {
  uid: string;
  fn: string;           // formatted name
  emails: string[];
  phones: string[];
  org?: string;
  title?: string;
  adr?: string;         // formatted address string
  note?: string;
  photoUrl?: string;    // only if PHOTO is a URL, not base64
}

/**
 * Unescape vCard text values.
 * vCard escapes: \n → newline, \, → comma, \; → semicolon, \\ → backslash
 */
function unescapeValue(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        result += '\n';
        i++;
      } else if (next === ',') {
        result += ',';
        i++;
      } else if (next === ';') {
        result += ';';
        i++;
      } else if (next === '\\') {
        result += '\\';
        i++;
      } else {
        result += value[i];
      }
    } else {
      result += value[i];
    }
  }
  return result;
}

/**
 * Parse a property line into name, params, and value.
 * Format: PROPERTY;param1=val1;param2=val2:value
 * Handles colons inside parameter values (e.g., VALUE=uri:https://...)
 */
function parsePropertyLine(line: string): { name: string; params: string[]; value: string } {
  // Split at the first colon that isn't inside a parameter value.
  // Property name and params come before the first colon, value after.
  // But params can contain things like VALUE=uri which doesn't have colons,
  // so we split on the first colon after the property name/params section.

  // Find where params end and value begins. The property group is everything
  // up to the first colon that's not part of a quoted param value.
  let inQuote = false;
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuote = !inQuote;
    } else if (line[i] === ':' && !inQuote) {
      colonIdx = i;
      break;
    }
  }

  if (colonIdx === -1) {
    return { name: '', params: [], value: line };
  }

  const propPart = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1);

  // Split property part by semicolons (first segment is name, rest are params)
  const segments = propPart.split(';');
  const name = (segments[0] || '').toUpperCase();
  const params = segments.slice(1);

  return { name, params, value };
}

/**
 * Extract PHOTO URL handling both v3.0 and v4.0 formats.
 * - v4.0: PHOTO property value is the URL directly
 * - v3.0: PHOTO;VALUE=uri:https://... — the value after the colon is the URL
 *         PHOTO;ENCODING=b;TYPE=JPEG:base64data — skip base64
 */
function extractPhotoUrl(params: string[], value: string): string | undefined {
  // Check if any param indicates this is a URI type (v3.0 style)
  const hasValueUri = params.some(p => p.toUpperCase().replace(/\s/g, '') === 'VALUE=URI');

  if (hasValueUri || value.startsWith('http')) {
    return value;
  }

  // Not a URL (likely base64 data) — skip
  return undefined;
}

/**
 * Parse ADR property: semicolon-separated components
 * PO Box; Extended Address; Street; City; Region; Postal Code; Country
 * Filter empty parts and join with ", "
 */
function parseAdr(value: string): string {
  return value
    .split(';')
    .map(part => unescapeValue(part.trim()))
    .filter(part => part.length > 0)
    .join(', ');
}

/**
 * Parse ORG property: semicolon-separated components (org; department; sub-department)
 * Filter empty parts and join with ", "
 */
function parseOrg(value: string): string {
  return value
    .split(';')
    .map(part => unescapeValue(part.trim()))
    .filter(part => part.length > 0)
    .join(', ');
}

/**
 * Unfold vCard lines. Continuation lines start with a space or tab.
 * Per RFC 6350, long lines are folded by inserting CRLF + whitespace.
 */
function unfoldLines(text: string): string {
  // Normalize to \n first, then handle unfolding
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/**
 * Parse one or more vCards from raw text.
 * Handles multiple vCards separated by BEGIN:VCARD / END:VCARD blocks.
 */
export function parseVCards(vcard: string): ParsedVCard[] {
  const unfolded = unfoldLines(vcard);
  const results: ParsedVCard[] = [];

  // Extract individual vCard blocks
  const blocks: string[] = [];
  let idx = 0;
  const upper = unfolded.toUpperCase();

  while (idx < unfolded.length) {
    const beginIdx = upper.indexOf('BEGIN:VCARD', idx);
    if (beginIdx === -1) break;

    const endIdx = upper.indexOf('END:VCARD', beginIdx);
    if (endIdx === -1) break;

    const blockEnd = endIdx + 'END:VCARD'.length;
    blocks.push(unfolded.substring(beginIdx, blockEnd));
    idx = blockEnd;
  }

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length > 0);

    let uid = '';
    let fn = '';
    const emails: string[] = [];
    const phones: string[] = [];
    let org: string | undefined;
    let title: string | undefined;
    let adr: string | undefined;
    let note: string | undefined;
    let photoUrl: string | undefined;

    for (const line of lines) {
      const { name, params, value } = parsePropertyLine(line);

      switch (name) {
        case 'UID':
          uid = value;
          break;
        case 'FN':
          fn = unescapeValue(value);
          break;
        case 'EMAIL':
          if (value.trim()) {
            emails.push(value.trim());
          }
          break;
        case 'TEL':
          if (value.trim()) {
            phones.push(value.trim());
          }
          break;
        case 'ORG':
          org = parseOrg(value);
          break;
        case 'TITLE':
          title = unescapeValue(value);
          break;
        case 'ADR':
          adr = parseAdr(value);
          break;
        case 'NOTE':
          note = unescapeValue(value);
          break;
        case 'PHOTO': {
          const url = extractPhotoUrl(params, value);
          if (url) {
            photoUrl = url;
          }
          break;
        }
      }
    }

    const card: ParsedVCard = { uid, fn, emails, phones };
    if (org !== undefined) card.org = org;
    if (title !== undefined) card.title = title;
    if (adr !== undefined) card.adr = adr;
    if (note !== undefined) card.note = note;
    if (photoUrl !== undefined) card.photoUrl = photoUrl;

    results.push(card);
  }

  return results;
}
