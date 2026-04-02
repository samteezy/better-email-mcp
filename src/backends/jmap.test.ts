import { JmapBackend, JmapError } from "./jmap";

// --- Test fixtures ---

const MOCK_SESSION = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "u123456",
  },
};

const MOCK_MAILBOXES = [
  { id: "mb1", name: "Inbox", parentId: null, role: "inbox" },
  { id: "mb2", name: "Drafts", parentId: null, role: "drafts" },
  { id: "mb3", name: "Sent", parentId: null, role: "sent" },
  { id: "mb4", name: "Work", parentId: null, role: null },
  { id: "mb5", name: "Projects", parentId: "mb4", role: null },
];

const MOCK_IDENTITIES = [
  { id: "id1", email: "user@fastmail.com", name: "Test User" },
];

const MOCK_EMAIL_RAW = {
  id: "email1",
  subject: "Hello world",
  from: [{ name: "Alice", email: "alice@example.com" }],
  to: [{ name: "Bob", email: "bob@example.com" }],
  cc: [{ name: "Carol", email: "carol@example.com" }],
  receivedAt: "2025-01-15T10:30:00Z",
  preview: "This is a preview of the email...",
  keywords: { $seen: true },
  mailboxIds: { mb1: true },
  hasAttachment: false,
};

const MOCK_EMAIL_UNREAD = {
  id: "email2",
  subject: "Unread message",
  from: [{ name: "Dave", email: "dave@example.com" }],
  to: [{ name: "Bob", email: "bob@example.com" }],
  cc: [],
  receivedAt: "2025-01-16T08:00:00Z",
  preview: "You haven't read this yet",
  keywords: {},
  mailboxIds: { mb1: true },
  hasAttachment: false,
};

// --- Helpers ---

function mockFetch(responses: Array<{ url?: string; response: any; status?: number }>) {
  const calls: Array<{ url: string; options: any }> = [];
  let callIndex = 0;

  const fn = jest.fn(async (url: string | URL, options?: any) => {
    calls.push({ url: url.toString(), options });
    const mock = responses[callIndex++];
    const status = mock?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => mock?.response,
    };
  });

  global.fetch = fn as any;
  return { fn, calls };
}

function makeApiResponse(methodResponses: any[][]) {
  return { methodResponses };
}

function setupConnectedBackend() {
  return mockFetch([
    // Session discovery
    { response: MOCK_SESSION },
    // Mailbox/get + Identity/get
    {
      response: makeApiResponse([
        ["Mailbox/get", { list: MOCK_MAILBOXES, notFound: [] }, "0"],
        ["Identity/get", { list: MOCK_IDENTITIES, notFound: [] }, "1"],
      ]),
    },
  ]);
}

// --- Tests ---

describe("JmapBackend", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("connect()", () => {
    it("discovers session and caches mailboxes + identity", async () => {
      const { calls } = setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });

      await backend.connect();

      // Session discovery call
      expect(calls[0].url).toBe(
        "https://api.fastmail.com/.well-known/jmap"
      );
      expect(calls[0].options.headers.Authorization).toBe(
        "Bearer test-token"
      );

      // Mailboxes are cached
      const folders = await backend.listFolders();
      expect(folders).toContain("Inbox");
      expect(folders).toContain("Drafts");
      expect(folders).toContain("Work/Projects");
    });

    it("throws on authentication failure", async () => {
      mockFetch([{ response: {}, status: 401 }]);
      const backend = new JmapBackend({ token: "bad-token" });

      await expect(backend.connect()).rejects.toThrow(
        "JMAP session discovery failed: 401"
      );
    });

    it("uses custom session URL when provided", async () => {
      const { calls } = mockFetch([
        { response: MOCK_SESSION },
        {
          response: makeApiResponse([
            ["Mailbox/get", { list: MOCK_MAILBOXES, notFound: [] }, "0"],
            ["Identity/get", { list: MOCK_IDENTITIES, notFound: [] }, "1"],
          ]),
        },
      ]);
      const backend = new JmapBackend({
        token: "test-token",
        sessionUrl: "https://custom.jmap.example/.well-known/jmap",
      });

      await backend.connect();
      expect(calls[0].url).toBe(
        "https://custom.jmap.example/.well-known/jmap"
      );
    });
  });

  describe("listFolders()", () => {
    it("returns sorted folder names including nested paths", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      const folders = await backend.listFolders();
      expect(folders).toEqual(["Drafts", "Inbox", "Sent", "Work", "Work/Projects"]);
    });
  });

  describe("listMessages()", () => {
    it("returns mapped EmailMessage objects", async () => {
      const { calls } = setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      mockFetch([
        {
          response: makeApiResponse([
            ["Email/query", { ids: ["email1", "email2"] }, "0"],
            [
              "Email/get",
              { list: [MOCK_EMAIL_RAW, MOCK_EMAIL_UNREAD], notFound: [] },
              "1",
            ],
          ]),
        },
      ]);

      const messages = await backend.listMessages();

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        id: "email1",
        subject: "Hello world",
        from: "alice@example.com",
        to: ["bob@example.com"],
        cc: ["carol@example.com"],
        date: "2025-01-15T10:30:00Z",
        snippet: "This is a preview of the email...",
        isRead: true,
        folder: "Inbox",
      });
      expect(messages[1].isRead).toBe(false);
    });

    it("includes inMailbox filter when folder is specified", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      const { calls } = mockFetch([
        {
          response: makeApiResponse([
            ["Email/query", { ids: [] }, "0"],
            ["Email/get", { list: [], notFound: [] }, "1"],
          ]),
        },
      ]);

      await backend.listMessages({ folder: "Inbox" });

      const requestBody = JSON.parse(calls[0].options.body);
      const queryArgs = requestBody.methodCalls[0][1];
      expect(queryArgs.filter.inMailbox).toBe("mb1");
    });

    it("throws on unknown folder", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      await expect(
        backend.listMessages({ folder: "Nonexistent" })
      ).rejects.toThrow("Unknown folder: Nonexistent");
    });
  });

  describe("getMessage()", () => {
    it("returns message with body assembled from bodyValues", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      mockFetch([
        {
          response: makeApiResponse([
            [
              "Email/get",
              {
                list: [
                  {
                    ...MOCK_EMAIL_RAW,
                    textBody: [{ partId: "1" }],
                    bodyValues: {
                      "1": { value: "Full body text of the email." },
                    },
                  },
                ],
                notFound: [],
              },
              "0",
            ],
          ]),
        },
      ]);

      const msg = await backend.getMessage("email1");

      expect(msg).not.toBeNull();
      expect(msg!.body).toBe("Full body text of the email.");
      expect(msg!.subject).toBe("Hello world");
    });

    it("returns null when message not found", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      mockFetch([
        {
          response: makeApiResponse([
            [
              "Email/get",
              { list: [], notFound: ["unknown-id"] },
              "0",
            ],
          ]),
        },
      ]);

      const msg = await backend.getMessage("unknown-id");
      expect(msg).toBeNull();
    });
  });

  describe("searchMessages()", () => {
    it("uses text filter in Email/query", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      const { calls } = mockFetch([
        {
          response: makeApiResponse([
            ["Email/query", { ids: ["email1"] }, "0"],
            ["Email/get", { list: [MOCK_EMAIL_RAW], notFound: [] }, "1"],
          ]),
        },
      ]);

      const results = await backend.searchMessages({ query: "hello" });

      expect(results).toHaveLength(1);
      const requestBody = JSON.parse(calls[0].options.body);
      const queryArgs = requestBody.methodCalls[0][1];
      expect(queryArgs.filter.text).toBe("hello");
    });
  });

  describe("sendMessage()", () => {
    it("creates draft and submits via EmailSubmission", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      const { calls } = mockFetch([
        {
          response: makeApiResponse([
            [
              "Email/set",
              { created: { draft: { id: "new-email-id" } } },
              "0",
            ],
            [
              "EmailSubmission/set",
              { created: { submission: { id: "sub1" } } },
              "1",
            ],
          ]),
        },
      ]);

      const result = await backend.sendMessage({
        to: ["recipient@example.com"],
        subject: "Test email",
        textBody: "Hello from tests!",
      });

      expect(result.id).toBe("new-email-id");

      const requestBody = JSON.parse(calls[0].options.body);
      const emailSetArgs = requestBody.methodCalls[0][1];
      expect(emailSetArgs.create.draft.to).toEqual([
        { email: "recipient@example.com" },
      ]);
      expect(emailSetArgs.create.draft.subject).toBe("Test email");

      const submissionArgs = requestBody.methodCalls[1][1];
      expect(submissionArgs.create.submission.emailId).toBe("#draft");
    });
  });

  describe("JMAP error handling", () => {
    it("throws JmapError on method-level error response", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      mockFetch([
        {
          response: makeApiResponse([
            [
              "error",
              {
                type: "invalidArguments",
                description: "The filter is not valid",
              },
              "0",
            ],
          ]),
        },
      ]);

      try {
        await backend.listMessages();
        fail("Expected JmapError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(JmapError);
        expect((err as JmapError).type).toBe("invalidArguments");
        expect((err as JmapError).message).toContain("invalidArguments");
      }
    });
  });

  describe("disconnect()", () => {
    it("clears session state", async () => {
      setupConnectedBackend();
      const backend = new JmapBackend({ token: "test-token" });
      await backend.connect();

      await backend.disconnect();

      await expect(backend.listMessages()).rejects.toThrow("Not connected");
    });
  });
});
