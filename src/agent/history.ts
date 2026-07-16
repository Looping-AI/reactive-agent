import type { ModelMessage } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * Session-history glue for the agent runtime: parse the gateway-authored `<turn>`
 * provenance wrapper, and bridge between plain text and the Agents-SDK Sessions
 * store. No A2A types cross this boundary — the {@link file://../a2a/inbound.ts
 * A2A adapter} has already reduced the inbound message to a plain string.
 *
 * The gateway inlines a `<turn from="…" id="…" channel="…" at="…">…</turn>` tag
 * into the message text in multi-actor channels so the model (and, in later
 * phases, recall) can attribute "who said what". This agent only *parses* that
 * wrapper — it never authors one.
 *
 * We persist only the user turn and the assistant's final text: intra-turn tool
 * steps stay inside the single `generateText` call, so stored history is plain
 * text messages and the conversion to AI-SDK `ModelMessage`s is trivial.
 */

/** The fields recovered from a gateway-rendered `<turn>` wrapper. */
export interface ParsedTurn {
  from: string;
  /** Slack user id, as rendered. */
  id: string;
  channel: string;
  /** ISO-8601 instant. */
  at: string;
  /** The raw inner body. */
  body: string;
}

const TURN_TAG_RE = /^<turn\b([^>]*)>([\s\S]*)<\/turn>$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Reverse the gateway's attribute escaping — single pass so `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, e) => ATTR_UNESCAPES[e]);
}

/**
 * Recover the structured provenance from a gateway-authored turn. Returns null
 * for any text that isn't a `<turn>` wrapper (plain messages, assistant replies),
 * so callers can treat the provenance as optional.
 */
export function parseTurn(text: string): ParsedTurn | null {
  const m = TURN_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  if (!attrs.from || !attrs.id || !attrs.channel || !attrs.at) return null;
  return {
    from: unescAttr(attrs.from),
    id: unescAttr(attrs.id),
    channel: unescAttr(attrs.channel),
    at: unescAttr(attrs.at),
    body: m[2]
  };
}

/**
 * Deterministic Session-message ids for the phased task pipeline.
 *
 * A phase runs inside a durable Workflow step that can re-run after a crash, so
 * its Session appends must be exactly-once. `Session.appendMessage` already
 * dedupes on message id (an id that exists is not re-written), so deriving the id
 * from the task id + phase makes the append idempotent for free — no
 * read-then-write race, no duplicate turns in history on replay. Pair with
 * {@link file://./session.ts appendOnce}, which reads the durable text back so a
 * retry that re-inferred still returns the *stored* reply.
 *
 * These ids share the Session id-space with random UUIDs (plain turns) and the
 * SDK's `compaction_`-prefixed summaries; the `task:` prefix cannot collide with
 * either.
 */

/** Id of the inbound user turn for a task (appended once, in Phase 1). */
export function taskUserMessageId(taskId: string): string {
  return `task:${taskId}:user`;
}

/** Id of the Phase 1 decomposition reply (the first user-visible message). */
export function decomposeReplyMessageId(taskId: string): string {
  return `task:${taskId}:reply:decompose`;
}

/** Id of the Phase 3 composed final reply. */
export function finalReplyMessageId(taskId: string): string {
  return `task:${taskId}:reply:final`;
}

/** A Sessions-store message with a caller-chosen (deterministic) id. */
export function deterministicSessionMessage(
  id: string,
  role: "user" | "assistant",
  text: string
): SessionMessage {
  return {
    id,
    role,
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  };
}

/** Concatenate the text parts of a stored session message. */
export function sessionText(m: SessionMessage): string {
  return m.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Convert stored history to AI-SDK model messages (user/assistant text only). */
export function toModelMessages(history: SessionMessage[]): ModelMessage[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: sessionText(m)
    }));
}
