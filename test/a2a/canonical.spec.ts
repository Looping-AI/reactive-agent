import { describe, it, expect } from "vitest";
import { canonicalCardPayload } from "@/a2a/canonical";

describe("canonicalCardPayload", () => {
  it("excludes the signatures field", () => {
    const card = {
      name: "Echo",
      signatures: [{ protected: "abc", signature: "xyz" }]
    };
    const result = JSON.parse(canonicalCardPayload(card));
    expect(result).not.toHaveProperty("signatures");
  });

  it("sorts top-level keys alphabetically", () => {
    const card = { z: "last", a: "first", m: "middle" };
    expect(canonicalCardPayload(card)).toBe(
      '{"a":"first","m":"middle","z":"last"}'
    );
  });

  it("sorts nested object keys recursively", () => {
    const card = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } };
    expect(canonicalCardPayload(card)).toBe(
      '{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}'
    );
  });

  it("preserves array order while sorting keys inside array elements", () => {
    const card = {
      items: [
        { b: 2, a: 1 },
        { d: 4, c: 3 }
      ]
    };
    expect(canonicalCardPayload(card)).toBe(
      '{"items":[{"a":1,"b":2},{"c":3,"d":4}]}'
    );
  });

  it("passes primitive values through unchanged", () => {
    const card = { flag: true, num: 42, str: "hello" };
    expect(canonicalCardPayload(card)).toBe(
      '{"flag":true,"num":42,"str":"hello"}'
    );
  });

  it("produces valid JSON with no whitespace", () => {
    const card = { name: "Agent", version: "1.0" };
    const result = canonicalCardPayload(card);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(result).not.toMatch(/\s/);
  });
});
