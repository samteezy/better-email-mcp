import {
  parseResponseLine,
  parseParenList,
  parseFetchResponse,
  parseSearchResponse,
  parseListResponse,
  decodeRfc2047,
  parseBodyStructure,
  flattenAttachments,
  findBodyPart,
  decodePartContent,
  decodeQuotedPrintable,
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

describe("parseBodyStructure", () => {
  it("parses a simple text/plain message", () => {
    // ("text" "plain" ("charset" "UTF-8") NIL NIL "7BIT" 1234 50)
    const list = ["text", "plain", ["charset", "UTF-8"], null, null, "7BIT", "1234", "50"];
    const part = parseBodyStructure(list);
    expect(part.partId).toBe("1");
    expect(part.type).toBe("text");
    expect(part.subtype).toBe("plain");
    expect(part.parameters).toEqual({ charset: "UTF-8" });
    expect(part.encoding).toBe("7BIT");
    expect(part.size).toBe(1234);
  });

  it("parses multipart/mixed with text + one attachment", () => {
    // ((text/plain)(application/pdf) "mixed")
    const list = [
      ["text", "plain", ["charset", "utf-8"], null, null, "7BIT", "500", "20"],
      ["application", "pdf", ["name", "report.pdf"], null, null, "BASE64", "9876"],
      "mixed",
    ];
    const part = parseBodyStructure(list);
    expect(part.type).toBe("multipart");
    expect(part.subtype).toBe("mixed");
    expect(part.parts).toHaveLength(2);
    expect(part.parts![0].partId).toBe("1");
    expect(part.parts![0].type).toBe("text");
    expect(part.parts![1].partId).toBe("2");
    expect(part.parts![1].type).toBe("application");
    expect(part.parts![1].subtype).toBe("pdf");
    expect(part.parts![1].size).toBe(9876);
  });

  it("parses nested multipart: mixed containing alternative + attachment", () => {
    // ((alternative: (text/plain)(text/html))(application/pdf) "mixed")
    const list = [
      [
        ["text", "plain", ["charset", "utf-8"], null, null, "QUOTED-PRINTABLE", "300", "10"],
        ["text", "html", ["charset", "utf-8"], null, null, "QUOTED-PRINTABLE", "800", "25"],
        "alternative",
      ],
      ["application", "pdf", ["name", "doc.pdf"], null, null, "BASE64", "5000"],
      "mixed",
    ];
    const part = parseBodyStructure(list);
    expect(part.type).toBe("multipart");
    expect(part.subtype).toBe("mixed");
    expect(part.parts).toHaveLength(2);

    const altPart = part.parts![0];
    expect(altPart.type).toBe("multipart");
    expect(altPart.subtype).toBe("alternative");
    expect(altPart.parts).toHaveLength(2);
    expect(altPart.parts![0].partId).toBe("1.1");
    expect(altPart.parts![1].partId).toBe("1.2");

    const pdfPart = part.parts![1];
    expect(pdfPart.partId).toBe("2");
    expect(pdfPart.type).toBe("application");
  });

  it("parses disposition from extension data", () => {
    // Single part with disposition
    const list = [
      "application", "pdf",
      ["name", "report.pdf"],
      null, null, "BASE64", "5000",
      // extension: md5, disposition
      null, ["attachment", ["filename", "report.pdf"]],
    ];
    const part = parseBodyStructure(list);
    expect(part.disposition).toBe("attachment");
    expect(part.dispositionParams).toEqual({ filename: "report.pdf" });
  });

  it("handles inline disposition with content-id", () => {
    const list = [
      "image", "png",
      ["name", "logo.png"],
      "<logo123@example.com>", null, "BASE64", "2048",
      null, ["inline", ["filename", "logo.png"]],
    ];
    const part = parseBodyStructure(list);
    expect(part.contentId).toBe("logo123@example.com");
    expect(part.disposition).toBe("inline");
  });

  it("handles missing parameters gracefully", () => {
    const list = ["application", "octet-stream", null, null, null, "BASE64", "100"];
    const part = parseBodyStructure(list);
    expect(part.parameters).toEqual({});
    expect(part.contentId).toBeNull();
    expect(part.disposition).toBeNull();
  });
});

describe("flattenAttachments", () => {
  it("returns empty for text-only message", () => {
    const part = parseBodyStructure(
      ["text", "plain", ["charset", "utf-8"], null, null, "7BIT", "500", "20"]
    );
    expect(flattenAttachments(part)).toEqual([]);
  });

  it("extracts attachments from multipart/mixed", () => {
    const structure = parseBodyStructure([
      ["text", "plain", ["charset", "utf-8"], null, null, "7BIT", "500", "20"],
      ["application", "pdf", ["name", "file.pdf"], null, null, "BASE64", "9876"],
      ["image", "jpeg", ["name", "photo.jpg"], null, null, "BASE64", "4000"],
      "mixed",
    ]);
    const attachments = flattenAttachments(structure);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].filename).toBe("file.pdf");
    expect(attachments[0].mimeType).toBe("application/pdf");
    expect(attachments[0].partId).toBe("2");
    expect(attachments[1].filename).toBe("photo.jpg");
    expect(attachments[1].partId).toBe("3");
  });

  it("skips text/html body but includes explicitly attached text", () => {
    const structure = parseBodyStructure([
      [
        ["text", "plain", ["charset", "utf-8"], null, null, "7BIT", "500", "20"],
        ["text", "html", ["charset", "utf-8"], null, null, "7BIT", "800", "25"],
        "alternative",
      ],
      "mixed",
    ]);
    expect(flattenAttachments(structure)).toEqual([]);
  });

  it("identifies inline images with content-id", () => {
    const structure = parseBodyStructure([
      ["text", "html", ["charset", "utf-8"], null, null, "7BIT", "800", "25"],
      ["image", "png", ["name", "logo.png"], "<cid123>", null, "BASE64", "2048",
        null, ["inline", ["filename", "logo.png"]]],
      "related",
    ]);
    const attachments = flattenAttachments(structure);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].isInline).toBe(true);
    expect(attachments[0].filename).toBe("logo.png");
  });

  it("uses fallback filename when none provided", () => {
    const structure = parseBodyStructure([
      ["text", "plain", null, null, null, "7BIT", "500", "20"],
      ["application", "octet-stream", null, null, null, "BASE64", "1000"],
      "mixed",
    ]);
    const attachments = flattenAttachments(structure);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("attachment-2");
  });
});

describe("findBodyPart", () => {
  it("finds a part by ID in nested structure", () => {
    const structure = parseBodyStructure([
      [
        ["text", "plain", null, null, null, "7BIT", "500", "20"],
        ["text", "html", null, null, null, "7BIT", "800", "25"],
        "alternative",
      ],
      ["application", "pdf", ["name", "doc.pdf"], null, null, "BASE64", "5000"],
      "mixed",
    ]);
    const found = findBodyPart(structure, "2");
    expect(found).not.toBeNull();
    expect(found!.type).toBe("application");
    expect(found!.subtype).toBe("pdf");

    const nested = findBodyPart(structure, "1.2");
    expect(nested).not.toBeNull();
    expect(nested!.type).toBe("text");
    expect(nested!.subtype).toBe("html");

    expect(findBodyPart(structure, "99")).toBeNull();
  });
});

describe("decodePartContent", () => {
  it("decodes base64 content", () => {
    const encoded = Buffer.from("Hello, World!").toString("base64");
    const decoded = decodePartContent(encoded, "BASE64");
    expect(decoded.toString()).toBe("Hello, World!");
  });

  it("handles base64 with whitespace", () => {
    const raw = "SGVs\r\nbG8=";
    const decoded = decodePartContent(raw, "BASE64");
    expect(decoded.toString()).toBe("Hello");
  });

  it("decodes quoted-printable content", () => {
    const decoded = decodePartContent("caf=C3=A9", "QUOTED-PRINTABLE");
    expect(decoded.toString("binary")).toBe("caf\xC3\xA9");
  });

  it("passes through 7bit content", () => {
    const decoded = decodePartContent("plain text", "7BIT");
    expect(decoded.toString("binary")).toBe("plain text");
  });
});

describe("decodeQuotedPrintable", () => {
  it("removes soft line breaks", () => {
    const decoded = decodeQuotedPrintable("Hello=\r\nWorld");
    expect(decoded.toString("binary")).toBe("HelloWorld");
  });

  it("decodes hex sequences", () => {
    const decoded = decodeQuotedPrintable("=48=65=6C=6C=6F");
    expect(decoded.toString()).toBe("Hello");
  });
});

describe("parseFetchResponse with BODYSTRUCTURE", () => {
  it("parses BODYSTRUCTURE in FETCH response", () => {
    const text = '(UID 42 BODYSTRUCTURE ("text" "plain" ("charset" "UTF-8") NIL NIL "7BIT" "500" "20"))';
    const parsed = parseFetchResponse(text);
    expect(parsed.uid).toBe(42);
    expect(parsed.bodyStructure).toBeDefined();
    expect(parsed.bodyStructure!.type).toBe("text");
    expect(parsed.bodyStructure!.subtype).toBe("plain");
  });

  it("parses BODY[section] into bodyParts map", () => {
    const content = "SGVsbG8="; // "Hello" in base64
    const text = `(UID 42 BODY[2] {${content.length}}${content})`;
    const parsed = parseFetchResponse(text);
    expect(parsed.uid).toBe(42);
    expect(parsed.bodyParts).toBeDefined();
    expect(parsed.bodyParts!.get("2")).toBe(content);
  });

  it("still stores BODY[TEXT] in bodyText", () => {
    const text = '(UID 42 BODY[TEXT] "Hello body")';
    const parsed = parseFetchResponse(text);
    expect(parsed.bodyText).toBe("Hello body");
    expect(parsed.bodyParts).toBeUndefined();
  });
});
