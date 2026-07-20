import type { Message, Part } from "@a2a-js/sdk";

/**
 * Inbound A2A-message glue: pull the plain user-turn text out of an A2A
 * `Message`. This is the one place the adapter reaches into the `@a2a-js/sdk`
 * message shape. File and data parts are out of scope for now — only text
 * crosses into the agent runtime.
 */

/** Bounds the inbound user text carried in a durable Workflow payload (UTF-8). */
export const MAX_INBOUND_TEXT_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** Invalid inbound content that must not cross the A2A-to-Workflow boundary. */
export class InboundPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundPartError";
  }
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

/**
 * Extract and validate the user-turn text. Rejects a message with no usable text
 * and enforces a single UTF-8 size bound before the text enters a Workflow
 * payload (platform payload limits).
 */
export function inboundText(message: Message): string {
  const text = textOf(message);
  if (!text) {
    throw new InboundPartError("message has no usable text");
  }
  if (encoder.encode(text).byteLength > MAX_INBOUND_TEXT_BYTES) {
    throw new InboundPartError("message text exceeds the size limit");
  }
  return text;
}
