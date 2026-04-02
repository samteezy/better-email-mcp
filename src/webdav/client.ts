/**
 * WebDAV HTTP client for PROPFIND and REPORT requests.
 * Uses native fetch() — no external dependencies.
 */

import { parseMultistatus, DavResponseEntry } from "./xml.js";

export interface WebDavConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export class WebDavError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`WebDAV error [${status}]: ${message}`);
    this.name = "WebDavError";
  }
}

export class WebDavClient {
  private config: WebDavConfig;

  constructor(config: WebDavConfig) {
    // Normalize baseUrl: strip trailing slash
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    };
  }

  async propfind(
    path: string,
    body: string,
    depth: "0" | "1" = "1"
  ): Promise<DavResponseEntry[]> {
    const xml = await this.request("PROPFIND", path, body, {
      Depth: depth,
    });
    return parseMultistatus(xml);
  }

  async report(path: string, body: string): Promise<DavResponseEntry[]> {
    const xml = await this.request("REPORT", path, body, {
      Depth: "1",
    });
    return parseMultistatus(xml);
  }

  async get(path: string): Promise<string> {
    return this.request("GET", path, undefined);
  }

  private async request(
    method: string,
    path: string,
    body: string | undefined,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      ...extraHeaders,
    };
    if (body) {
      headers["Content-Type"] = "application/xml; charset=utf-8";
    }

    const res = await fetch(url, { method, headers, body });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebDavError(
        res.status,
        `${method} ${url} failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
      );
    }

    return res.text();
  }

  private buildUrl(path: string): string {
    const baseOrigin = new URL(this.config.baseUrl).origin;
    let url: string;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      url = path;
    } else if (path.startsWith("/")) {
      url = `${baseOrigin}${path}`;
    } else {
      url = `${this.config.baseUrl}/${path}`;
    }
    // Prevent SSRF: never send credentials to a foreign origin
    if (new URL(url).origin !== baseOrigin) {
      throw new Error(`Refusing request to foreign origin: ${url}`);
    }
    return url;
  }

  private authHeader(): string {
    const credentials = `${this.config.username}:${this.config.password}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
}
