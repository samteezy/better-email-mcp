/**
 * Minimal IMAP client using Node's built-in net/tls modules.
 * Supports only the commands needed by the IMAP backend:
 * LOGIN, LIST, SELECT, UID SEARCH, UID FETCH, LOGOUT.
 */

import * as net from "net";
import * as tls from "tls";
import { parseResponseLine, ImapResponse } from "./parser.js";

export interface ImapClientConfig {
  host: string;
  port: number;
  tls: boolean;
}

export class ImapError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(`IMAP error [${code}]: ${message}`);
    this.name = "ImapError";
  }
}

export class ImapClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private tagCounter = 0;
  private buffer = "";
  private literalRemaining = 0;
  private literalBuffer = "";
  private currentLines: string[] = [];

  // Pending command awaiting tagged response
  private pending: {
    tag: string;
    responses: ImapResponse[];
    resolve: (responses: ImapResponse[]) => void;
    reject: (err: Error) => void;
  } | null = null;

  // Queue for incoming lines when no command is pending
  private greetingResolve: ((resp: ImapResponse) => void) | null = null;

  async connect(config: ImapClientConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const onGreeting = (resp: ImapResponse) => {
        if (resp.type === "OK" || resp.type === "PREAUTH") {
          resolve();
        } else {
          reject(new ImapError("greeting", `Server rejected connection: ${resp.text}`));
        }
      };

      this.greetingResolve = onGreeting;

      const onConnect = () => {
        // Socket connected, waiting for greeting
      };

      const onError = (err: Error) => {
        this.greetingResolve = null;
        reject(new ImapError("connect", err.message));
      };

      if (config.tls) {
        this.socket = tls.connect(
          { host: config.host, port: config.port },
          onConnect
        );
      } else {
        this.socket = net.connect(
          { host: config.host, port: config.port },
          onConnect
        );
      }

      this.socket.setEncoding("utf-8");
      this.socket.on("data", (data: string) => this.onData(data));
      this.socket.on("error", onError);
      this.socket.on("close", () => {
        if (this.pending) {
          this.pending.reject(new ImapError("closed", "Connection closed unexpectedly"));
          this.pending = null;
        }
        this.socket = null;
      });
    });
  }

  /**
   * Send an IMAP command and collect all responses until the tagged completion.
   * Returns array of untagged responses. Throws on NO/BAD.
   */
  async command(cmd: string): Promise<ImapResponse[]> {
    if (!this.socket) {
      throw new ImapError("disconnected", "Not connected");
    }

    const tag = `A${++this.tagCounter}`;

    return new Promise((resolve, reject) => {
      this.pending = { tag, responses: [], resolve, reject };
      this.socket!.write(`${tag} ${cmd}\r\n`);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) return;

    try {
      await this.command("LOGOUT");
    } catch {
      // Ignore errors during logout
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // --- Private ---

  private onData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      // If we're reading a literal, consume bytes
      if (this.literalRemaining > 0) {
        if (this.buffer.length < this.literalRemaining) {
          // Not enough data yet
          this.literalBuffer += this.buffer;
          this.literalRemaining -= this.buffer.length;
          this.buffer = "";
          return;
        }

        this.literalBuffer += this.buffer.substring(0, this.literalRemaining);
        this.buffer = this.buffer.substring(this.literalRemaining);
        this.literalRemaining = 0;

        // Append literal content to the current line being built
        this.currentLines[this.currentLines.length - 1] += this.literalBuffer;
        this.literalBuffer = "";
        // Continue processing — the line continues after the literal
        continue;
      }

      // Look for end of line
      const crlfIdx = this.buffer.indexOf("\r\n");
      if (crlfIdx === -1) return; // Need more data

      const line = this.buffer.substring(0, crlfIdx);
      this.buffer = this.buffer.substring(crlfIdx + 2);

      // Check if line ends with a literal marker {N}
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        this.literalRemaining = parseInt(literalMatch[1], 10);
        this.literalBuffer = "";
        // Store partial line (without the {N}) for continuation
        this.currentLines.push(line.substring(0, line.length - literalMatch[0].length));
        continue;
      }

      // Complete line — join with any previous literal parts
      let fullLine: string;
      if (this.currentLines.length > 0) {
        this.currentLines.push(line);
        fullLine = this.currentLines.join("");
        this.currentLines = [];
      } else {
        fullLine = line;
      }

      this.handleLine(fullLine);
    }
  }

  private handleLine(line: string): void {
    const resp = parseResponseLine(line);

    // Server greeting (before any command)
    if (this.greetingResolve && resp.tag === "*") {
      const resolve = this.greetingResolve;
      this.greetingResolve = null;
      resolve(resp);
      return;
    }

    if (!this.pending) return;

    // Untagged response — collect it
    if (resp.tag === "*" || resp.tag === "+") {
      this.pending.responses.push(resp);
      return;
    }

    // Tagged response — check if it matches our pending command
    if (resp.tag === this.pending.tag) {
      const { responses, resolve, reject } = this.pending;
      this.pending = null;

      if (resp.type === "OK") {
        resolve(responses);
      } else {
        reject(new ImapError(resp.type ?? "unknown", resp.text || "Command failed"));
      }
    }
  }
}
