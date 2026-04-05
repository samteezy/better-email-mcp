import { ImapBackend, encodeMessageId, decodeMessageId, validateTagName } from "./imap";

// --- Mock ImapClient ---

jest.mock("../imap/client", () => {
  const mockClient = {
    connect: jest.fn(),
    command: jest.fn(),
    disconnect: jest.fn(),
  };

  return {
    ImapClient: jest.fn(() => mockClient),
    ImapError: class ImapError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(`IMAP error [${code}]: ${message}`);
        this.name = "ImapError";
        this.code = code;
      }
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock("../imap/client") as any;

function resetMocks() {
  mockClient.connect.mockReset();
  mockClient.command.mockReset();
  mockClient.disconnect.mockReset();
}

// --- Test fixtures ---

const LIST_RESPONSES = [
  { tag: "*", type: "LIST", text: '(\\HasNoChildren) "/" "INBOX"' },
  { tag: "*", type: "LIST", text: '(\\HasNoChildren) "/" "Drafts"' },
  { tag: "*", type: "LIST", text: '(\\HasNoChildren) "/" "Sent"' },
  { tag: "*", type: "LIST", text: '(\\HasChildren) "/" "Work"' },
  { tag: "*", type: "LIST", text: '(\\HasNoChildren) "/" "Work/Projects"' },
];

const FETCH_ENVELOPE_1 =
  '("Mon, 15 Jan 2025 10:30:00 +0000" "Hello world" ' +
  '(("Alice" NIL "alice" "example.com")) ' +  // from
  '(("Alice" NIL "alice" "example.com")) ' +  // sender
  '(("Alice" NIL "alice" "example.com")) ' +  // reply-to
  '(("Bob" NIL "bob" "example.com")) ' +       // to
  '(("Carol" NIL "carol" "example.com")) ' +   // cc
  "NIL " +                                      // bcc
  "NIL " +                                      // in-reply-to
  '"<msg1@example.com>")';                      // message-id

const FETCH_ENVELOPE_2 =
  '("Tue, 16 Jan 2025 08:00:00 +0000" "Unread message" ' +
  '(("Dave" NIL "dave" "example.com")) ' +
  '(("Dave" NIL "dave" "example.com")) ' +
  '(("Dave" NIL "dave" "example.com")) ' +
  '(("Bob" NIL "bob" "example.com")) ' +
  "NIL NIL NIL " +
  '"<msg2@example.com>")';

const FETCH_RESPONSES = [
  {
    tag: "*",
    type: "FETCH",
    num: 1,
    text: `(UID 100 FLAGS (\\Seen) ENVELOPE ${FETCH_ENVELOPE_1})`,
  },
  {
    tag: "*",
    type: "FETCH",
    num: 2,
    text: `(UID 101 FLAGS () ENVELOPE ${FETCH_ENVELOPE_2})`,
  },
];

// --- Helpers ---

async function createConnectedBackend(): Promise<ImapBackend> {
  resetMocks();
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.command.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith("LOGIN")) return [];
    if (cmd.startsWith("LIST")) return LIST_RESPONSES;
    return [];
  });

  const backend = new ImapBackend({
    host: "imap.example.com",
    port: 993,
    user: "testuser",
    password: "testpass",
    tls: true,
  });
  await backend.connect();
  return backend;
}

// --- Tests ---

describe("ImapBackend", () => {
  describe("connect()", () => {
    it("connects, logs in, and caches folders", async () => {
      const backend = await createConnectedBackend();

      expect(mockClient.connect).toHaveBeenCalledWith({
        host: "imap.example.com",
        port: 993,
        tls: true,
      });

      // LOGIN was called
      const loginCall = mockClient.command.mock.calls.find(
        (c: string[]) => c[0].startsWith("LOGIN")
      );
      expect(loginCall).toBeDefined();

      // LIST was called
      const listCall = mockClient.command.mock.calls.find(
        (c: string[]) => c[0].startsWith("LIST")
      );
      expect(listCall).toBeDefined();

      // Folders are cached
      const folders = await backend.listFolders();
      expect(folders).toEqual([
        "Drafts",
        "INBOX",
        "Sent",
        "Work",
        "Work/Projects",
      ]);
    });

    it("throws on authentication failure", async () => {
      resetMocks();
      mockClient.connect.mockResolvedValue(undefined);
      mockClient.command.mockRejectedValue(
        new Error("IMAP error [NO]: Invalid credentials")
      );

      const backend = new ImapBackend({
        host: "imap.example.com",
        port: 993,
        user: "bad",
        password: "bad",
        tls: true,
      });

      await expect(backend.connect()).rejects.toThrow("Invalid credentials");
    });
  });

  describe("disconnect()", () => {
    it("disconnects and clears state", async () => {
      const backend = await createConnectedBackend();
      await backend.disconnect();

      await expect(backend.listMessages()).rejects.toThrow("Not connected");
    });
  });

  describe("listFolders()", () => {
    it("returns sorted folder names", async () => {
      const backend = await createConnectedBackend();
      const folders = await backend.listFolders();
      expect(folders).toEqual([
        "Drafts",
        "INBOX",
        "Sent",
        "Work",
        "Work/Projects",
      ]);
    });
  });

  describe("listMessages()", () => {
    it("returns mapped EmailMessage objects", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          return [{ tag: "*", type: "SEARCH", text: "100 101" }];
        }
        if (cmd.startsWith("UID FETCH")) return FETCH_RESPONSES;
        return [];
      });

      const messages = await backend.listMessages({ folder: "INBOX" });

      expect(messages).toHaveLength(2);
      // Newest first (UID 101 > 100)
      expect(messages[0].id).toBe("INBOX:101");
      expect(messages[0].subject).toBe("Unread message");
      expect(messages[0].from).toBe("dave@example.com");
      expect(messages[0].isRead).toBe(false);

      expect(messages[1].id).toBe("INBOX:100");
      expect(messages[1].subject).toBe("Hello world");
      expect(messages[1].from).toBe("alice@example.com");
      expect(messages[1].to).toEqual(["bob@example.com"]);
      expect(messages[1].cc).toEqual(["carol@example.com"]);
      expect(messages[1].isRead).toBe(true);
      expect(messages[1].folder).toBe("INBOX");
    });

    it("throws on unknown folder", async () => {
      const backend = await createConnectedBackend();

      await expect(
        backend.listMessages({ folder: "Nonexistent" })
      ).rejects.toThrow("Unknown folder: Nonexistent");
    });

    it("returns empty array when no messages", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          return [{ tag: "*", type: "SEARCH", text: "" }];
        }
        return [];
      });

      const messages = await backend.listMessages({ folder: "INBOX" });
      expect(messages).toEqual([]);
    });
  });

  describe("getMessage()", () => {
    it("returns message with body text", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID FETCH")) {
          return [
            {
              tag: "*",
              type: "FETCH",
              num: 1,
              text: `(UID 100 FLAGS (\\Seen) ENVELOPE ${FETCH_ENVELOPE_1} BODY[TEXT] "Full body text of the email.")`,
            },
          ];
        }
        return [];
      });

      const msg = await backend.getMessage("INBOX:100");

      expect(msg).not.toBeNull();
      expect(msg!.id).toBe("INBOX:100");
      expect(msg!.subject).toBe("Hello world");
      expect(msg!.body).toBe("Full body text of the email.");
    });

    it("returns null when message not found", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID FETCH")) {
          throw new Error("UID not found");
        }
        return [];
      });

      const msg = await backend.getMessage("INBOX:99999");
      expect(msg).toBeNull();
    });
  });

  describe("searchMessages()", () => {
    it("uses SEARCH TEXT and returns results", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          expect(cmd).toContain("TEXT");
          expect(cmd).toContain("hello");
          return [{ tag: "*", type: "SEARCH", text: "100" }];
        }
        if (cmd.startsWith("UID FETCH")) {
          return [FETCH_RESPONSES[0]];
        }
        return [];
      });

      const results = await backend.searchMessages({ query: "hello" });

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Hello world");
    });

    it("returns empty array when no matches", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          return [{ tag: "*", type: "SEARCH", text: "" }];
        }
        return [];
      });

      const results = await backend.searchMessages({ query: "nonexistent" });
      expect(results).toEqual([]);
    });
  });

  describe("tagMessages()", () => {
    it("adds a tag using UID STORE +FLAGS", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      const result = await backend.tagMessages({
        ids: ["INBOX:100", "INBOX:101"],
        tag: "processed",
        action: "add",
      });

      expect(result.tagged).toEqual(["INBOX:100", "INBOX:101"]);
      expect(commands).toContain("SELECT INBOX");
      expect(commands.find((c) => c.includes("UID STORE 100,101 +FLAGS (processed)"))).toBeDefined();
    });

    it("removes a tag using UID STORE -FLAGS", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      const result = await backend.tagMessages({
        ids: ["INBOX:100"],
        tag: "follow-up",
        action: "remove",
      });

      expect(result.tagged).toEqual(["INBOX:100"]);
      expect(commands.find((c) => c.includes("-FLAGS (follow-up)"))).toBeDefined();
    });

    it("groups messages by folder when tagging across folders", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      await backend.tagMessages({
        ids: ["INBOX:100", "Sent:200"],
        tag: "important",
        action: "add",
      });

      const selectCommands = commands.filter((c) => c.startsWith("SELECT"));
      expect(selectCommands).toHaveLength(2);
      expect(commands.find((c) => c.includes("UID STORE 100 +FLAGS (important)"))).toBeDefined();
      expect(commands.find((c) => c.includes("UID STORE 200 +FLAGS (important)"))).toBeDefined();
    });

    it("rejects invalid tag names", async () => {
      const backend = await createConnectedBackend();

      await expect(
        backend.tagMessages({ ids: ["INBOX:100"], tag: "has spaces", action: "add" })
      ).rejects.toThrow("letters, digits, hyphens, and underscores");

      await expect(
        backend.tagMessages({ ids: ["INBOX:100"], tag: "$system", action: "add" })
      ).rejects.toThrow("reserved for system flags");

      await expect(
        backend.tagMessages({ ids: ["INBOX:100"], tag: "\\Seen", action: "add" })
      ).rejects.toThrow("reserved for system flags");
    });

    it("throws on unknown folder", async () => {
      const backend = await createConnectedBackend();

      await expect(
        backend.tagMessages({ ids: ["Nonexistent:100"], tag: "test", action: "add" })
      ).rejects.toThrow("Unknown folder: Nonexistent");
    });
  });

  describe("moveMessages()", () => {
    it("moves messages using UID MOVE", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      const result = await backend.moveMessages({
        ids: ["INBOX:100", "INBOX:101"],
        folder: "Sent",
      });

      expect(result.moved).toEqual(["INBOX:100", "INBOX:101"]);
      expect(commands).toContain("SELECT INBOX");
      expect(commands.find((c) => c.includes("UID MOVE 100,101 Sent"))).toBeDefined();
    });

    it("falls back to COPY+DELETE+EXPUNGE when MOVE fails", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        if (cmd.startsWith("UID MOVE")) {
          throw new Error("MOVE not supported");
        }
        return [];
      });

      const result = await backend.moveMessages({
        ids: ["INBOX:100"],
        folder: "Drafts",
      });

      expect(result.moved).toEqual(["INBOX:100"]);
      expect(commands.find((c) => c.includes("UID COPY 100"))).toBeDefined();
      expect(commands.find((c) => c.includes("UID STORE 100 +FLAGS (\\Deleted)"))).toBeDefined();
      expect(commands).toContain("EXPUNGE");
    });

    it("skips messages already in the destination folder", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      const result = await backend.moveMessages({
        ids: ["INBOX:100"],
        folder: "INBOX",
      });

      expect(result.moved).toEqual([]);
      // No MOVE or COPY should have been issued
      expect(commands.find((c) => c.includes("UID MOVE"))).toBeUndefined();
    });

    it("groups messages from different source folders", async () => {
      const backend = await createConnectedBackend();
      const commands: string[] = [];

      mockClient.command.mockImplementation(async (cmd: string) => {
        commands.push(cmd);
        return [];
      });

      const result = await backend.moveMessages({
        ids: ["INBOX:100", "Sent:200"],
        folder: "Drafts",
      });

      expect(result.moved).toEqual(["INBOX:100", "Sent:200"]);
      const selectCommands = commands.filter((c) => c.startsWith("SELECT"));
      expect(selectCommands).toHaveLength(2);
    });

    it("throws on unknown destination folder", async () => {
      const backend = await createConnectedBackend();

      await expect(
        backend.moveMessages({ ids: ["INBOX:100"], folder: "Nonexistent" })
      ).rejects.toThrow("Unknown folder: Nonexistent");
    });
  });

  describe("tags in listMessages()", () => {
    it("exposes custom flags as tags, excluding system flags", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          return [{ tag: "*", type: "SEARCH", text: "100" }];
        }
        if (cmd.startsWith("UID FETCH")) {
          return [
            {
              tag: "*",
              type: "FETCH",
              num: 1,
              text: `(UID 100 FLAGS (\\Seen processed follow-up) ENVELOPE ${FETCH_ENVELOPE_1})`,
            },
          ];
        }
        return [];
      });

      const messages = await backend.listMessages({ folder: "INBOX" });

      expect(messages[0].tags).toEqual(["processed", "follow-up"]);
      expect(messages[0].isRead).toBe(true);
    });

    it("omits tags field when no custom flags exist", async () => {
      const backend = await createConnectedBackend();

      mockClient.command.mockImplementation(async (cmd: string) => {
        if (cmd.startsWith("SELECT")) return [];
        if (cmd.startsWith("UID SEARCH")) {
          return [{ tag: "*", type: "SEARCH", text: "100" }];
        }
        if (cmd.startsWith("UID FETCH")) return [FETCH_RESPONSES[0]];
        return [];
      });

      const messages = await backend.listMessages({ folder: "INBOX" });

      expect(messages[0].tags).toBeUndefined();
    });
  });
});

describe("Message ID encoding", () => {
  it("encodes folder and UID", () => {
    expect(encodeMessageId("INBOX", 42)).toBe("INBOX:42");
    expect(encodeMessageId("Work/Projects", 100)).toBe("Work/Projects:100");
  });

  it("decodes folder and UID", () => {
    expect(decodeMessageId("INBOX:42")).toEqual({ folder: "INBOX", uid: 42 });
    expect(decodeMessageId("Work/Projects:100")).toEqual({
      folder: "Work/Projects",
      uid: 100,
    });
  });

  it("round-trips correctly", () => {
    const id = encodeMessageId("Nested/Folder/Deep", 999);
    const decoded = decodeMessageId(id);
    expect(decoded).toEqual({ folder: "Nested/Folder/Deep", uid: 999 });
  });

  it("throws on malformed ID", () => {
    expect(() => decodeMessageId("nocolon")).toThrow("Malformed message ID");
  });
});

describe("validateTagName()", () => {
  it("accepts valid tag names", () => {
    expect(() => validateTagName("processed")).not.toThrow();
    expect(() => validateTagName("follow-up")).not.toThrow();
    expect(() => validateTagName("project_x")).not.toThrow();
    expect(() => validateTagName("ABC123")).not.toThrow();
  });

  it("rejects empty tags", () => {
    expect(() => validateTagName("")).toThrow("1–255 characters");
  });

  it("rejects tags starting with backslash", () => {
    expect(() => validateTagName("\\Seen")).toThrow("reserved for system flags");
  });

  it("rejects tags starting with $", () => {
    expect(() => validateTagName("$flagged")).toThrow("reserved for system flags");
  });

  it("rejects tags with spaces", () => {
    expect(() => validateTagName("has space")).toThrow("letters, digits, hyphens, and underscores");
  });

  it("rejects tags with special characters", () => {
    expect(() => validateTagName("tag@name")).toThrow("letters, digits, hyphens, and underscores");
    expect(() => validateTagName("tag.name")).toThrow("letters, digits, hyphens, and underscores");
    expect(() => validateTagName("tag/name")).toThrow("letters, digits, hyphens, and underscores");
  });

  it("rejects tags over 255 characters", () => {
    expect(() => validateTagName("a".repeat(256))).toThrow("1–255 characters");
  });

  it("accepts tags at max length", () => {
    expect(() => validateTagName("a".repeat(255))).not.toThrow();
  });
});
