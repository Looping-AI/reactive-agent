import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  toRecallVectors,
  archiveMessages,
  recallSearch,
  type RecallIndex
} from "@/agent/recall";
import { RECALL_METADATA_TEXT_MAX } from "@/config";

function userMsg(id: string, text: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}
function assistantMsg(id: string, text: string): SessionMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const TURN =
  '<turn from="Ada" id="U123" channel="C9" at="2026-07-03T10:00:00Z">hello there</turn>';

/** A fake Vectorize index that records upserts and returns canned query matches. */
function fakeIndex(matches: VectorizeMatch[] = []) {
  const upserts: VectorizeVector[][] = [];
  const queries: { vector: number[]; options?: VectorizeQueryOptions }[] = [];
  const index: RecallIndex = {
    async upsert(vectors) {
      upserts.push(vectors);
      return { ids: vectors.map((v) => v.id), count: vectors.length };
    },
    async query(vector, options) {
      queries.push({ vector, options });
      return { matches, count: matches.length };
    }
  };
  return { index, upserts, queries };
}

/** Deterministic stub embed: one distinct vector per input, tracking calls. */
function stubEmbed() {
  const calls: string[][] = [];
  const embed = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((_, i) => [i, i + 1, i + 2]);
  };
  return { embed, calls };
}

describe("toRecallVectors", () => {
  it("uses the message id as the vector id and binds the namespace", () => {
    const vectors = toRecallVectors([userMsg("m1", "plain text")], "ns:1", [
      [1, 2, 3]
    ]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0].id).toBe("m1");
    expect(vectors[0].namespace).toBe("ns:1");
    expect(vectors[0].values).toEqual([1, 2, 3]);
  });

  it("lifts <turn> provenance into metadata for user turns", () => {
    const [v] = toRecallVectors([userMsg("m1", TURN)], "ns:1", [[0]]);
    expect(v.metadata).toMatchObject({
      role: "user",
      author: "Ada",
      authorId: "U123",
      channel: "C9",
      at: "2026-07-03T10:00:00Z"
    });
    expect(v.metadata?.text).toBe(TURN);
  });

  it("omits provenance for messages without a <turn> wrapper", () => {
    const [v] = toRecallVectors([assistantMsg("a1", "sure thing")], "ns:1", [
      [0]
    ]);
    expect(v.metadata).toEqual({ role: "assistant", text: "sure thing" });
  });

  it("truncates the stored text to the metadata cap", () => {
    const long = "x".repeat(RECALL_METADATA_TEXT_MAX + 500);
    const [v] = toRecallVectors([userMsg("m1", long)], "ns:1", [[0]]);
    expect((v.metadata?.text as string).length).toBe(RECALL_METADATA_TEXT_MAX);
  });
});

describe("archiveMessages", () => {
  it("embeds non-empty texts and upserts them under the namespace", async () => {
    const { index, upserts } = fakeIndex();
    const { embed, calls } = stubEmbed();
    await archiveMessages(
      index,
      "ns:1",
      [userMsg("m1", "one"), userMsg("m2", "two")],
      embed
    );
    expect(calls).toEqual([["one", "two"]]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].map((v) => v.id)).toEqual(["m1", "m2"]);
    expect(upserts[0].every((v) => v.namespace === "ns:1")).toBe(true);
  });

  it("skips empty/whitespace messages", async () => {
    const { index, upserts } = fakeIndex();
    const { embed, calls } = stubEmbed();
    await archiveMessages(
      index,
      "ns:1",
      [userMsg("m1", "kept"), userMsg("m2", "   ")],
      embed
    );
    expect(calls).toEqual([["kept"]]);
    expect(upserts[0].map((v) => v.id)).toEqual(["m1"]);
  });

  it("no-ops (no embed, no upsert) when nothing has text", async () => {
    const { index, upserts } = fakeIndex();
    const { embed, calls } = stubEmbed();
    await archiveMessages(index, "ns:1", [userMsg("m1", "")], embed);
    expect(calls).toEqual([]);
    expect(upserts).toEqual([]);
  });
});

describe("recallSearch", () => {
  it("queries within the namespace and maps metadata to results", async () => {
    const { index, queries } = fakeIndex([
      {
        id: "m1",
        score: 0.91,
        metadata: {
          role: "user",
          text: "hello there",
          author: "Ada",
          authorId: "U123",
          channel: "C9",
          at: "2026-07-03T10:00:00Z"
        }
      } as VectorizeMatch
    ]);
    const { embed } = stubEmbed();
    const results = await recallSearch(index, "ns:1", "greeting", embed, 3);

    expect(queries[0].options).toMatchObject({
      namespace: "ns:1",
      topK: 3,
      returnMetadata: "all"
    });
    expect(results).toEqual([
      {
        score: 0.91,
        role: "user",
        text: "hello there",
        author: "Ada",
        authorId: "U123",
        channel: "C9",
        at: "2026-07-03T10:00:00Z"
      }
    ]);
  });

  it("tolerates matches without metadata", async () => {
    const { index } = fakeIndex([{ id: "m1", score: 0.5 } as VectorizeMatch]);
    const { embed } = stubEmbed();
    const [r] = await recallSearch(index, "ns:1", "q", embed);
    expect(r).toEqual({ score: 0.5, role: "unknown", text: "" });
  });
});
