import type { Message, Part } from "@a2a-js/sdk";

/**
 * Inbound A2A-message glue: pull plain text out of an A2A `Message`. This is the
 * one place the adapter reaches into the `@a2a-js/sdk` message shape; everything
 * past {@link file://./executor.ts A2AExecutor} works in plain strings, so
 * the agent runtime never sees an A2A type.
 */

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
