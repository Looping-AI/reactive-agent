import { describe, it, expect } from "vitest";
import type { Message, Part } from "@a2a-js/sdk";
import {
  InboundPartError,
  MAX_INBOUND_TEXT_BYTES,
  inboundText,
  textOf
} from "@/a2a/inbound";

function message(parts: Part[]): Message {
  return { parts } as unknown as Message;
}

/** A v1.0 text part. */
function text(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  };
}

/** A v1.0 file part (by URL) — the "not text" case. */
function file(url: string): Part {
  return {
    content: { $case: "url", value: url },
    metadata: undefined,
    filename: "doc.pdf",
    mediaType: "application/pdf"
  };
}

describe("textOf", () => {
  it("concatenates text parts and trims", () => {
    expect(textOf(message([text(" foo"), text("bar ")]))).toBe("foobar");
  });

  it("ignores non-text parts", () => {
    expect(
      textOf(message([file("https://example.test/doc.pdf"), text("keep")]))
    ).toBe("keep");
  });
});

describe("inboundText", () => {
  it("returns the trimmed user-turn text", () => {
    expect(inboundText(message([text(" hello ")]))).toBe("hello");
  });

  it("rejects a message with no usable text", () => {
    expect(() => inboundText(message([text("  ")]))).toThrow(InboundPartError);
    expect(() =>
      inboundText(message([file("https://example.test/doc.pdf")]))
    ).toThrow(/no usable text/);
  });

  it("rejects text over the UTF-8 size limit", () => {
    expect(() =>
      inboundText(message([text("x".repeat(MAX_INBOUND_TEXT_BYTES + 1))]))
    ).toThrow(/size limit/);
  });
});
