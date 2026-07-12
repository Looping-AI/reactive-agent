import type { Message, Part } from "@a2a-js/sdk";
import type {
  ConversationFileBytes,
  ConversationFileUri,
  ConversationPart,
  JsonValue
} from "./parts";

/**
 * Inbound A2A-message glue: pull plain text out of an A2A `Message`. This is the
 * one place the adapter reaches into the `@a2a-js/sdk` message shape. It emits
 * only metadata-free, JSON-safe values suitable for native Durable Object RPC.
 */

/** Bounds the number of parts carried in a durable Workflow payload. */
export const MAX_INBOUND_PARTS = 32;

/** Bounds one sanitized part's UTF-8 JSON representation. */
export const MAX_INBOUND_PART_BYTES = 64 * 1024;

/** Bounds all sanitized parts' UTF-8 JSON representation. */
export const MAX_INBOUND_TOTAL_BYTES = 256 * 1024;

const MAX_JSON_DEPTH = 32;
const encoder = new TextEncoder();

/** Invalid inbound content that must not cross the A2A-to-Workflow boundary. */
export class InboundPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundPartError";
  }
}

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as UnknownRecord)
    : null;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InboundPartError(`${field} must be a string`);
  }
  return value;
}

function sanitizeJsonValue(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>()
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new InboundPartError("data exceeds the maximum JSON nesting depth");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InboundPartError("data contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new InboundPartError("data contains a circular reference");
    }
    ancestors.add(value);
    const sanitized = value.map((item) =>
      sanitizeJsonValue(item, depth + 1, ancestors)
    );
    ancestors.delete(value);
    return sanitized;
  }
  const record = recordOf(value);
  if (!record) {
    throw new InboundPartError("data must contain only JSON-safe values");
  }
  if (ancestors.has(record)) {
    throw new InboundPartError("data contains a circular reference");
  }
  ancestors.add(record);
  const entries = Object.entries(record).map(([key, item]) => [
    key,
    sanitizeJsonValue(item, depth + 1, ancestors)
  ]);
  ancestors.delete(record);
  return Object.fromEntries(entries);
}

function sanitizeFile(
  file: unknown
): ConversationFileBytes | ConversationFileUri {
  const record = recordOf(file);
  if (!record) throw new InboundPartError("file must be an object");

  const bytes = record.bytes;
  const uri = record.uri;
  if (typeof bytes === "string" && uri === undefined) {
    if (!bytes) throw new InboundPartError("file.bytes must not be empty");
    return {
      bytes,
      mimeType: optionalString(record.mimeType, "file.mimeType"),
      name: optionalString(record.name, "file.name")
    };
  }
  if (typeof uri === "string" && bytes === undefined) {
    if (!uri) throw new InboundPartError("file.uri must not be empty");
    try {
      new URL(uri);
    } catch {
      throw new InboundPartError("file.uri must be a valid URL");
    }
    return {
      uri,
      mimeType: optionalString(record.mimeType, "file.mimeType"),
      name: optionalString(record.name, "file.name")
    };
  }
  throw new InboundPartError("file must contain exactly one of bytes or uri");
}

function sanitizePart(part: Part): ConversationPart | null {
  if (part.kind === "text") {
    if (!part.text.trim()) return null;
    return { kind: "text", text: part.text };
  }
  if (part.kind === "file") {
    return { kind: "file", file: sanitizeFile(part.file) };
  }
  if (part.kind === "data") {
    const data = sanitizeJsonValue(part.data);
    if (Array.isArray(data) || data === null || typeof data !== "object") {
      throw new InboundPartError("data must be a JSON object");
    }
    return { kind: "data", data };
  }
  throw new InboundPartError("unsupported inbound part kind");
}

/**
 * Strip SDK metadata and validate every inbound part before it enters a Workflow
 * payload. Blank text is ignored; all malformed supported parts are rejected.
 */
export function sanitizeParts(message: Message): ConversationPart[] {
  const input = message.parts ?? [];
  if (input.length > MAX_INBOUND_PARTS) {
    throw new InboundPartError(
      `message has more than ${MAX_INBOUND_PARTS} parts`
    );
  }

  let totalBytes = 0;
  const sanitized: ConversationPart[] = [];
  for (const part of input) {
    const clean = sanitizePart(part);
    if (!clean) continue;
    const bytes = encoder.encode(JSON.stringify(clean)).byteLength;
    if (bytes > MAX_INBOUND_PART_BYTES) {
      throw new InboundPartError("inbound part exceeds the size limit");
    }
    totalBytes += bytes;
    if (totalBytes > MAX_INBOUND_TOTAL_BYTES) {
      throw new InboundPartError("inbound parts exceed the total size limit");
    }
    sanitized.push(clean);
  }
  return sanitized;
}

/** Concatenate the text parts of an inbound A2A message. */
export function textOf(message: Message): string {
  return (message.parts ?? [])
    .filter(
      (p: Part): p is Extract<Part, { kind: "text" }> => p.kind === "text"
    )
    .map((p) => p.text)
    .join("")
    .trim();
}
