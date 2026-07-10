import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  assistantSessionMessage,
  parseTurn,
  sessionText,
  toModelMessages,
  userSessionMessage
} from "@/agent/history";

describe("parseTurn", () => {
  it("parses a well-formed <turn> wrapper", () => {
    const t = parseTurn(
      '<turn from="Ada" id="U1" channel="general" at="2026-07-01T00:00:00.000Z">hello there</turn>'
    );
    expect(t).toEqual({
      from: "Ada",
      id: "U1",
      channel: "general",
      at: "2026-07-01T00:00:00.000Z",
      body: "hello there"
    });
  });

  it("unescapes attribute entities", () => {
    const t = parseTurn(
      '<turn from="A &amp; B" id="U1" channel="general" at="x">hi</turn>'
    );
    expect(t?.from).toBe("A & B");
  });

  it("returns null for plain text", () => {
    expect(parseTurn("just a normal message")).toBeNull();
  });

  it("returns null when a required attribute is missing", () => {
    // no `id`
    expect(
      parseTurn('<turn from="Ada" channel="general" at="x">hi</turn>')
    ).toBeNull();
  });
});

describe("session message glue", () => {
  it("builds a user session message with a text part and unique id", () => {
    const a = userSessionMessage("hi");
    const b = userSessionMessage("hi");
    expect(a.role).toBe("user");
    expect(sessionText(a)).toBe("hi");
    expect(a.id).not.toBe(b.id);
  });

  it("builds an assistant session message", () => {
    const m = assistantSessionMessage("reply");
    expect(m.role).toBe("assistant");
    expect(sessionText(m)).toBe("reply");
  });

  it("concatenates multiple text parts in sessionText", () => {
    const m = {
      id: "x",
      role: "user",
      parts: [
        { type: "text", text: "foo" },
        { type: "text", text: "bar" }
      ]
    } as unknown as SessionMessage;
    expect(sessionText(m)).toBe("foobar");
  });

  it("converts stored history to user/assistant model messages", () => {
    const history = [userSessionMessage("q"), assistantSessionMessage("a")];
    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" }
    ]);
  });

  it("drops non-user/assistant roles when converting", () => {
    const history = [
      { id: "s", role: "system", parts: [{ type: "text", text: "sys" }] },
      userSessionMessage("q")
    ] as unknown as SessionMessage[];
    expect(toModelMessages(history)).toEqual([{ role: "user", content: "q" }]);
  });
});
