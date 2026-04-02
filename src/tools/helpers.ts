import { z } from "zod";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function parseDisabledTools(): Set<string> {
  const raw = process.env.DISABLED_TOOLS ?? "";
  if (!raw.trim()) return new Set();
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

export function toolEnabled(name: string, disabled: Set<string>): boolean {
  return !disabled.has(name.toLowerCase());
}
