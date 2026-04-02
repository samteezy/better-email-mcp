import {
  parseResponseLine,
  parseParenList,
  parseFetchResponse,
  parseSearchResponse,
  parseListResponse,
  decodeRfc2047,
} from "./parser";

describe("parseResponseLine", () => {
  it("parses tagged OK response", () => {
    const resp = parseResponseLine("A1 OK Login successful");
    expect(resp.tag).toBe("A1");
    expect(resp.type).toBe("OK");
    expect(resp.text).toBe("Login successful");
  });

  it("parses tagged NO response", () => {
    const resp = parseResponseLine("A2 NO [AUTHENTICATIONFAILED] Invalid credentials");
    expect(resp.tag).toBe("A2");
    expect(resp.type).toBe("NO");
    expect(resp.text).toBe("[AUTHENTICATIONFAILED] Invalid credentials");
  });

  it("parses tagged BAD response", () => {
    const resp = parseResponseLine("A3 BAD Command unknown");
    expect(resp.tag).toBe("A3");
    expect(resp.type).toBe("BAD");
  });

  it("parses untagged EXISTS", () => {
    const resp = parseResponseLine("* 42 EXISTS");
    expect(resp.tag).toBe("*");
    expect(resp.num).toBe(42);
    expect(resp.type).toBe("EXISTS");
  });

  it("parses untagged FETCH", () => {
    const resp = parseResponseLine('* 1 FETCH (UID 100 FLAGS (\\Seen))');
    expect(resp.tag).toBe("*");
    expect(resp.num).toBe(1);
    expect(resp.type).toBe("FETCH");
  });

  it("parses untagged SEARCH", () => {
    const resp = parseResponseLine("* SEARCH 1 4 9 23");
    expect(resp.tag).toBe("*");
    expect(resp.type).toBe("SEARCH");
    expect(resp.text).toBe("1 4 9 23");
  });

  it("parses untagged OK", () => {
    const resp = parseResponseLine("* OK Grstrstrstreetings");
    expect(resp.tag).toBe("*");
    expect(resp.type).toBe("OK");
  });

  it("parses continuation response", () => {
    const resp = parseResponseLine("+ Ready for literal data");
    expect(resp.tag).toBe("+");
    expect(resp.text).toBe("Ready for literal data");
  });

  it("parses untagged LIST", () => {
    const resp = parseResponseLine('* LIST (\\HasNoChildren) "/" "INBOX"');
    expect(resp.tag).toBe("*");
    expect(resp.type).toBe("LIST");
  });
});

describe("parseParenList", () => {
  it("parses simple flag list", () => {
    const { value } = parseParenList("(\\Seen \\Flagged)");
    expect(value).toEqual(["\\Seen", "\\Flagged"]);
  });

  it("parses list with NIL", () => {
    const { value } = parseParenList("(NIL NIL)");
    expect(value).toEqual([null, null]);
  });

  it("parses list with quoted strings", () => {
    const { value } = parseParenList('("hello world" "foo")');
    expect(value).toEqual(["hello world", "foo"]);
  });

  it("parses nested lists", () => {
    const { value } = parseParenList("((a b) (c d))");
    expect(value).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("parses empty list", () => {
    const { value } = parseParenList("()");
    expect(value).toEqual([]);
  });

  it("parses IMAP address tuple", () => {
    // (name adl mailbox host)
    const { value } = parseParenList('(("Alice" NIL "alice" "example.com"))');
    expect(value).toEqual([["Alice", null, "alice", "example.com"]]);
  });

  it("handles escaped quotes in strings", () => {
    const { value } = parseParenList('("say \\"hi\\"")');
    expect(value).toEqual(['say "hi"']);
  });
});

describe("parseFetchResponse", () => {
  it("parses UID and FLAGS", () => {
    const result = parseFetchResponse("(UID 42 FLAGS (\\Seen \\Flagged))");
    expect(result.uid).toBe(42);
    expect(result.flags).toEqual(["\\Seen", "\\Flagged"]);
  });

  it("parses ENVELOPE", () => {
    const envelope = '("Mon, 15 Jan 2025 10:30:00 +0000" "Hello world" (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Alice" NIL "alice" "example.com")) (("Bob" NIL "bob" "example.com")) NIL NIL NIL "<msg123@example.com>")';
    const result = parseFetchResponse(`(UID 1 ENVELOPE ${envelope})`);

    expect(result.uid).toBe(1);
    expect(result.envelope).toBeDefined();
    expect(result.envelope!.subject).toBe("Hello world");
    expect(result.envelope!.from).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ]);
    expect(result.envelope!.to).toEqual([
      { name: "Bob", email: "bob@example.com" },
    ]);
    expect(result.envelope!.messageId).toBe("<msg123@example.com>");
  });

  it("parses ENVELOPE with CC", () => {
    const envelope = '("Mon, 15 Jan 2025 10:30:00 +0000" "Test" (("Alice" NIL "alice" "example.com")) NIL NIL (("Bob" NIL "bob" "example.com")) (("Carol" NIL "carol" "example.com")) NIL NIL "<msg@example.com>")';
    const result = parseFetchResponse(`(UID 2 ENVELOPE ${envelope})`);

    expect(result.envelope!.cc).toEqual([
      { name: "Carol", email: "carol@example.com" },
    ]);
  });

  it("parses ENVELOPE with NIL fields", () => {
    const envelope = '("Mon, 15 Jan 2025" "Subject" (("Sender" NIL "sender" "example.com")) NIL NIL (("Recip" NIL "recip" "example.com")) NIL NIL NIL NIL)';
    const result = parseFetchResponse(`(UID 3 ENVELOPE ${envelope})`);

    expect(result.envelope!.cc).toEqual([]);
    expect(result.envelope!.bcc).toEqual([]);
    expect(result.envelope!.inReplyTo).toBe("");
  });

  it("parses FLAGS without \\Seen as unread", () => {
    const result = parseFetchResponse("(UID 5 FLAGS (\\Recent))");
    expect(result.flags).toEqual(["\\Recent"]);
    expect(result.flags).not.toContain("\\Seen");
  });

  it("parses BODY[TEXT] with quoted string", () => {
    const result = parseFetchResponse('(UID 10 BODY[TEXT] "Hello this is body text")');
    expect(result.bodyText).toBe("Hello this is body text");
  });
});

describe("parseSearchResponse", () => {
  it("parses UID list", () => {
    expect(parseSearchResponse("1 4 9 23")).toEqual([1, 4, 9, 23]);
  });

  it("handles empty search", () => {
    expect(parseSearchResponse("")).toEqual([]);
  });

  it("handles single result", () => {
    expect(parseSearchResponse("42")).toEqual([42]);
  });
});

describe("parseListResponse", () => {
  it("parses standard LIST response", () => {
    const result = parseListResponse('(\\HasNoChildren) "/" "INBOX"');
    expect(result).toEqual({
      flags: ["\\HasNoChildren"],
      delimiter: "/",
      name: "INBOX",
    });
  });

  it("parses LIST with multiple flags", () => {
    const result = parseListResponse('(\\HasNoChildren \\Trash) "/" "Trash"');
    expect(result).toEqual({
      flags: ["\\HasNoChildren", "\\Trash"],
      delimiter: "/",
      name: "Trash",
    });
  });

  it("parses LIST with dot delimiter", () => {
    const result = parseListResponse('(\\HasChildren) "." "Work.Projects"');
    expect(result).toEqual({
      flags: ["\\HasChildren"],
      delimiter: ".",
      name: "Work.Projects",
    });
  });

  it("parses unquoted mailbox name", () => {
    const result = parseListResponse("(\\HasNoChildren) \"/\" INBOX");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("INBOX");
  });
});

describe("decodeRfc2047", () => {
  it("decodes base64 encoded word", () => {
    // "Hello" in base64
    const encoded = "=?UTF-8?B?SGVsbG8=?=";
    expect(decodeRfc2047(encoded)).toBe("Hello");
  });

  it("decodes quoted-printable encoded word", () => {
    const encoded = "=?UTF-8?Q?Hello_World?=";
    expect(decodeRfc2047(encoded)).toBe("Hello World");
  });

  it("decodes QP with hex escapes", () => {
    // é = C3 A9 in UTF-8
    const encoded = "=?UTF-8?Q?caf=C3=A9?=";
    expect(decodeRfc2047(encoded)).toBe("café");
  });

  it("passes through plain text unchanged", () => {
    expect(decodeRfc2047("Hello World")).toBe("Hello World");
  });

  it("handles mixed encoded and plain text", () => {
    const input = "Re: =?UTF-8?B?SGVsbG8=?= there";
    expect(decodeRfc2047(input)).toBe("Re: Hello there");
  });

  it("handles null/empty input", () => {
    expect(decodeRfc2047("")).toBe("");
  });
});
