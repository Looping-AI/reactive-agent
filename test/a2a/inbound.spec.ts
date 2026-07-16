import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import {
  InboundPartError,
  MAX_INBOUND_TEXT_BYTES,
  inboundText,
  textOf
} from "@/a2a/inbound";

function message(parts: unknown[]): Message {
  return { parts } as unknown as Message;
}

describe("textOf", () => {
  it("concatenates text parts and trims", () => {
    expect(
      textOf(
        message([
          { kind: "text", text: " foo" },
          { kind: "text", text: "bar " }
        ])
      )
    ).toBe("foobar");
  });

  it("ignores non-text parts", () => {
    expect(
      textOf(
        message([
          { kind: "file", file: {} },
          { kind: "text", text: "keep" }
        ])
      )
    ).toBe("keep");
  });
});

describe("inboundText", () => {
  it("returns the trimmed user-turn text", () => {
    expect(inboundText(message([{ kind: "text", text: " hello " }]))).toBe(
      "hello"
    );
  });

  it("rejects a message with no usable text", () => {
    expect(() => inboundText(message([{ kind: "text", text: "  " }]))).toThrow(
      InboundPartError
    );
    expect(() => inboundText(message([{ kind: "file", file: {} }]))).toThrow(
      /no usable text/
    );
  });

  it("rejects text over the UTF-8 size limit", () => {
    expect(() =>
      inboundText(
        message([
          { kind: "text", text: "x".repeat(MAX_INBOUND_TEXT_BYTES + 1) }
        ])
      )
    ).toThrow(/size limit/);
  });
});
