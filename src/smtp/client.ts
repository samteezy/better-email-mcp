/**
 * Minimal SMTP client using Node's built-in net/tls modules.
 * Supports EHLO, AUTH PLAIN, STARTTLS, and message submission.
 */

import * as net from "net";
import * as tls from "tls";

export interface SmtpClientConfig {
  host: string;
  port: number;
  tls: boolean;
}

export class SmtpError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(`SMTP error [${code}]: ${message}`);
    this.name = "SmtpError";
  }
}

function validateAddress(address: string): void {
  if (/[\r\n\x00<>]/.test(address)) {
    throw new SmtpError(
      "invalid_address",
      "Email address contains illegal characters"
    );
  }
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

export class SmtpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private host = "";
  private buffer = "";
  private capabilities: string[] = [];

  private responseResolve: ((resp: SmtpResponse) => void) | null = null;
  private responseReject: ((err: Error) => void) | null = null;
  private responseLines: string[] = [];

  async connect(config: SmtpClientConfig): Promise<void> {
    this.host = config.host;
    return new Promise((resolve, reject) => {
      this.responseResolve = (resp) => {
        if (resp.code === 220) {
          resolve();
        } else {
          reject(
            new SmtpError(
              "greeting",
              `Server rejected connection: ${resp.lines.join(" ")}`
            )
          );
        }
      };
      this.responseReject = reject;

      const onError = (err: Error) => {
        this.responseResolve = null;
        this.responseReject = null;
        reject(new SmtpError("connect", err.message));
      };

      if (config.tls) {
        this.socket = tls.connect(
          { host: config.host, port: config.port },
          () => {
            // Connected, waiting for greeting
          }
        );
      } else {
        this.socket = net.connect(
          { host: config.host, port: config.port },
          () => {
            // Connected, waiting for greeting
          }
        );
      }

      this.socket.setEncoding("utf-8");
      this.socket.on("data", (data: string) => this.onData(data));
      this.socket.on("error", onError);
      this.socket.on("close", () => {
        if (this.responseReject) {
          this.responseReject(
            new SmtpError("closed", "Connection closed unexpectedly")
          );
          this.responseResolve = null;
          this.responseReject = null;
        }
        this.socket = null;
      });
    });
  }

  async ehlo(hostname: string): Promise<string[]> {
    const resp = await this.sendCommand(`EHLO ${hostname}`, [250]);
    this.capabilities = resp;
    return resp;
  }

  async startTls(): Promise<void> {
    if (!this.socket) {
      throw new SmtpError("disconnected", "Not connected");
    }

    const hasStartTls = this.capabilities.some(
      (c) => c.toUpperCase() === "STARTTLS"
    );
    if (!hasStartTls) {
      throw new SmtpError("starttls", "Server does not advertise STARTTLS");
    }

    await this.sendCommand("STARTTLS", [220]);

    // Upgrade the socket to TLS
    const rawSocket = this.socket as net.Socket;
    rawSocket.removeAllListeners("data");

    const tlsSocket = tls.connect({ socket: rawSocket, servername: this.host });

    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
    });

    this.socket = tlsSocket;
    this.buffer = "";
    this.socket.setEncoding("utf-8");
    this.socket.on("data", (data: string) => this.onData(data));
  }

  async authPlain(user: string, password: string): Promise<void> {
    const credentials = Buffer.from(`\0${user}\0${password}`).toString(
      "base64"
    );
    await this.sendCommand(`AUTH PLAIN ${credentials}`, [235]);
  }

  async mailFrom(address: string): Promise<void> {
    validateAddress(address);
    await this.sendCommand(`MAIL FROM:<${address}>`, [250]);
  }

  async rcptTo(address: string): Promise<void> {
    validateAddress(address);
    await this.sendCommand(`RCPT TO:<${address}>`, [250]);
  }

  async data(content: string): Promise<void> {
    await this.sendCommand("DATA", [354]);

    // Normalize line endings to CRLF
    let body = content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");

    // Dot-stuffing: any line starting with "." gets an extra "." prepended (RFC 5321 §4.5.2)
    body = body.replace(/\r\n\./g, "\r\n..");
    // Also handle if the body itself starts with a dot
    if (body.startsWith(".")) {
      body = "." + body;
    }

    // Send body followed by terminating sequence
    this.writeRaw(body + "\r\n.\r\n");
    await this.readResponse([250]);
  }

  async quit(): Promise<void> {
    try {
      await this.sendCommand("QUIT", [221]);
    } catch {
      // Ignore errors during quit
    }
    this.destroySocket();
  }

  disconnect(): void {
    this.destroySocket();
  }

  // --- Private ---

  private async sendCommand(
    cmd: string,
    expectedCodes: number[]
  ): Promise<string[]> {
    if (!this.socket) {
      throw new SmtpError("disconnected", "Not connected");
    }

    this.writeRaw(cmd + "\r\n");
    return this.readResponse(expectedCodes);
  }

  private readResponse(expectedCodes: number[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.responseLines = [];
      this.responseResolve = (resp) => {
        if (expectedCodes.includes(resp.code)) {
          resolve(resp.lines);
        } else {
          reject(
            new SmtpError(
              String(resp.code),
              resp.lines.join(" ") || `Unexpected response code ${resp.code}`
            )
          );
        }
      };
      this.responseReject = reject;

      // Process any data already in the buffer
      this.processBuffer();
    });
  }

  private writeRaw(data: string): void {
    if (!this.socket) {
      throw new SmtpError("disconnected", "Not connected");
    }
    this.socket.write(data);
  }

  private onData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const crlfIdx = this.buffer.indexOf("\r\n");
      if (crlfIdx === -1) return;

      const line = this.buffer.substring(0, crlfIdx);
      this.buffer = this.buffer.substring(crlfIdx + 2);

      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // SMTP responses: "NNN-text" (continuation) or "NNN text" (final)
    const match = line.match(/^(\d{3})([ -])(.*)/);
    if (!match) return;

    const code = parseInt(match[1], 10);
    const isContinuation = match[2] === "-";
    const text = match[3];

    this.responseLines.push(text);

    if (!isContinuation && this.responseResolve) {
      const resolve = this.responseResolve;
      this.responseResolve = null;
      this.responseReject = null;
      resolve({ code, lines: this.responseLines });
      this.responseLines = [];
    }
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.responseResolve = null;
    this.responseReject = null;
  }
}
