import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { textOf } from "@/a2a/inbound";

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
