import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import { archivingCompaction } from "@/agent/session";
import { COMPACT_AFTER_TOKENS, COMPACT_TAIL_TOKENS } from "@/config";

function msg(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

const history = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];

// A base compaction that folds the b..d range into a summary.
const base = (async () => ({
  summary: "sum",
  fromMessageId: "b",
  toMessageId: "d"
})) as unknown as Parameters<typeof archivingCompaction>[0];

/**
 * The two compaction constants are one setting, and the failure of getting them
 * wrong is silent: put the threshold too close to the tail and the fixed floor
 * (system prompt + protected head + summary) eats the gap, so compaction fires on
 * nearly every append and spends a summarizer call on a near-empty middle. See
 * the derivation on `COMPACT_TAIL_TOKENS`.
 */
describe("compaction tuning", () => {
  it("leaves enough room between the threshold and the tail", () => {
    expect(COMPACT_AFTER_TOKENS - COMPACT_TAIL_TOKENS).toBeGreaterThanOrEqual(
      10_000
    );
  });
});

describe("archivingCompaction", () => {
  it("hands exactly the displaced range to onArchive and returns the base result", async () => {
    let archived: SessionMessage[] = [];
    const fn = archivingCompaction(base, async (m) => {
      archived = m;
    });
    const result = await fn(history);
    expect(archived.map((m) => m.id)).toEqual(["b", "c", "d"]);
    expect(result).toMatchObject({ fromMessageId: "b", toMessageId: "d" });
  });

  it("returns the base function unchanged when there is no onArchive", () => {
    expect(archivingCompaction(base)).toBe(base);
  });

  it("swallows archive errors so compaction still shortens history", async () => {
    const fn = archivingCompaction(base, async () => {
      throw new Error("vectorize down");
    });
    const result = await fn(history);
    expect(result).toMatchObject({ summary: "sum" });
  });

  it("does not archive when the base compaction returns null", async () => {
    let called = false;
    const nullBase = (async () => null) as unknown as Parameters<
      typeof archivingCompaction
    >[0];
    const fn = archivingCompaction(nullBase, async () => {
      called = true;
    });
    expect(await fn(history)).toBeNull();
    expect(called).toBe(false);
  });
});
