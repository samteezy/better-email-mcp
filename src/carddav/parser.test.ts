import { parseVCards, ParsedVCard } from '../carddav/parser';

describe('vCard parser', () => {
  it('parses basic vCard with fn, uid, email, and phone', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:abc-123',
      'FN:Alice Smith',
      'EMAIL:alice@example.com',
      'TEL:+1-555-0100',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards).toHaveLength(1);
    expect(cards[0].uid).toBe('abc-123');
    expect(cards[0].fn).toBe('Alice Smith');
    expect(cards[0].emails).toEqual(['alice@example.com']);
    expect(cards[0].phones).toEqual(['+1-555-0100']);
  });

  it('parses multiple emails and phones', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:multi-1',
      'FN:Bob Jones',
      'EMAIL;TYPE=work:bob@work.com',
      'EMAIL;TYPE=home:bob@home.com',
      'TEL;TYPE=cell:+1-555-0001',
      'TEL;TYPE=home:+1-555-0002',
      'TEL;TYPE=work:+1-555-0003',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].emails).toEqual(['bob@work.com', 'bob@home.com']);
    expect(cards[0].phones).toEqual(['+1-555-0001', '+1-555-0002', '+1-555-0003']);
  });

  it('parses ORG with sub-organizations', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:org-1',
      'FN:Carol White',
      'ORG:Acme Corp;Engineering;Platform Team',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].org).toBe('Acme Corp, Engineering, Platform Team');
  });

  it('filters empty ORG components', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:org-2',
      'FN:Dan Green',
      'ORG:Acme Corp;;',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].org).toBe('Acme Corp');
  });

  it('parses ADR into formatted string', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:adr-1',
      'FN:Eve Black',
      'ADR;TYPE=home:;;123 Main St;Springfield;IL;62704;USA',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].adr).toBe('123 Main St, Springfield, IL, 62704, USA');
  });

  it('parses NOTE with escaped characters', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:note-1',
      'FN:Frank Lee',
      'NOTE:Line one\\nLine two\\, with comma\\; and semicolon\\\\end',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].note).toBe('Line one\nLine two, with comma; and semicolon\\end');
  });

  it('extracts PHOTO URL in v4.0 format', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:photo-v4',
      'FN:Grace Hall',
      'PHOTO:https://example.com/photo.jpg',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].photoUrl).toBe('https://example.com/photo.jpg');
  });

  it('extracts PHOTO URL in v3.0 VALUE=uri format', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:photo-v3',
      'FN:Hank Moore',
      'PHOTO;VALUE=uri:https://example.com/avatar.png',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].photoUrl).toBe('https://example.com/avatar.png');
  });

  it('skips PHOTO with base64 data', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:photo-b64',
      'FN:Iris Chen',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].photoUrl).toBeUndefined();
  });

  it('handles multi-line unfolding', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:unfold-1',
      'FN:Jack',
      ' son Pollock',
      'NOTE:This is a very long',
      '\t note that spans lines',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].fn).toBe('Jackson Pollock');
    expect(cards[0].note).toBe('This is a very long note that spans lines');
  });

  it('parses multiple vCards in one response', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:card-1',
      'FN:Person One',
      'EMAIL:one@example.com',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:card-2',
      'FN:Person Two',
      'EMAIL:two@example.com',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards).toHaveLength(2);
    expect(cards[0].uid).toBe('card-1');
    expect(cards[0].fn).toBe('Person One');
    expect(cards[0].emails).toEqual(['one@example.com']);
    expect(cards[1].uid).toBe('card-2');
    expect(cards[1].fn).toBe('Person Two');
    expect(cards[1].emails).toEqual(['two@example.com']);
  });

  it('handles missing FN with fallback to empty string', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:no-fn',
      'EMAIL:nofn@example.com',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].fn).toBe('');
    expect(cards[0].emails).toEqual(['nofn@example.com']);
  });

  it('handles missing UID with fallback to empty string', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:No UID Person',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].uid).toBe('');
    expect(cards[0].fn).toBe('No UID Person');
  });

  it('returns empty array for input with no vCards', () => {
    expect(parseVCards('')).toEqual([]);
    expect(parseVCards('just some random text')).toEqual([]);
  });

  it('handles LF-only line endings', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:lf-only',
      'FN:LF Person',
      'END:VCARD',
    ].join('\n');

    const cards = parseVCards(input);
    expect(cards).toHaveLength(1);
    expect(cards[0].fn).toBe('LF Person');
  });

  it('handles TITLE property', () => {
    const input = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'UID:title-1',
      'FN:Kim Park',
      'TITLE:Senior Engineer',
      'END:VCARD',
    ].join('\r\n');

    const cards = parseVCards(input);
    expect(cards[0].title).toBe('Senior Engineer');
  });
});
