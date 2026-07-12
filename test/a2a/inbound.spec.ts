import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import {
  InboundPartError,
  MAX_INBOUND_PARTS,
  MAX_INBOUND_PART_BYTES,
  sanitizeParts,
  textOf
} from "@/a2a/inbound";

function message(parts: unknown[]): Message {
  return { parts } as unknown as Message;
}

describe("textOf", () => {
  it("concatenates text parts and trims", () => {
    const msg = {
      parts: [
        { kind: "text", text: " foo" },
        { kind: "text", text: "bar " }
      ]
    } as unknown as Message;
    expect(textOf(msg)).toBe("foobar");
  });

  it("ignores non-text parts", () => {
    const msg = {
      parts: [
        { kind: "file", file: {} },
        { kind: "text", text: "keep" }
      ]
    } as unknown as Message;
    expect(textOf(msg)).toBe("keep");
  });
});

describe("sanitizeParts", () => {
  it("preserves supported part payloads while stripping A2A metadata", () => {
    const parts = sanitizeParts(
      message([
        { kind: "text", text: "hello", metadata: { ignored: true } },
        {
          kind: "file",
          file: {
            bytes: "YWJj",
            mimeType: "text/plain",
            name: "note.txt"
          },
          metadata: { ignored: true }
        },
        {
          kind: "file",
          file: { uri: "https://example.test/report.pdf" },
          metadata: { ignored: true }
        },
        {
          kind: "data",
          data: { nested: [true, { count: 2 }] },
          metadata: { ignored: true }
        }
      ])
    );

    expect(parts).toEqual([
      { kind: "text", text: "hello" },
      {
        kind: "file",
        file: {
          bytes: "YWJj",
          mimeType: "text/plain",
          name: "note.txt"
        }
      },
      {
        kind: "file",
        file: { uri: "https://example.test/report.pdf" }
      },
      { kind: "data", data: { nested: [true, { count: 2 }] } }
    ]);
  });

  it("ignores blank text but keeps other usable structured content", () => {
    expect(
      sanitizeParts(
        message([
          { kind: "text", text: "  " },
          { kind: "data", data: { status: "ready" } }
        ])
      )
    ).toEqual([{ kind: "data", data: { status: "ready" } }]);
  });

  it("rejects malformed file descriptors", () => {
    expect(() =>
      sanitizeParts(
        message([
          { kind: "file", file: { bytes: "x", uri: "https://example.test" } }
        ])
      )
    ).toThrow(InboundPartError);
    expect(() =>
      sanitizeParts(message([{ kind: "file", file: { uri: "not-a-url" } }]))
    ).toThrow(/valid URL/);
  });

  it("rejects data that is not JSON-safe", () => {
    expect(() =>
      sanitizeParts(message([{ kind: "data", data: { missing: undefined } }]))
    ).toThrow(/JSON-safe/);
    expect(() =>
      sanitizeParts(message([{ kind: "data", data: ["not", "an", "object"] }]))
    ).toThrow(/JSON object/);
  });

  it("enforces part count and UTF-8 payload limits", () => {
    expect(() =>
      sanitizeParts(
        message(
          Array.from({ length: MAX_INBOUND_PARTS + 1 }, () => ({
            kind: "text",
            text: "part"
          }))
        )
      )
    ).toThrow(/more than/);
    expect(() =>
      sanitizeParts(
        message([
          {
            kind: "text",
            text: "x".repeat(MAX_INBOUND_PART_BYTES)
          }
        ])
      )
    ).toThrow(/size limit/);
  });
});
