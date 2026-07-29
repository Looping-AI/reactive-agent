import { env } from "cloudflare:workers";
import type { GatewayIdentity } from "@/a2a/verify";
import { renderTypeCapabilities } from "./subtasks/subtask-types";

/**
 * The agent's soul — its frozen identity + operating rules. Kept as an array of
 * lines so it reads as a checklist and stays easy to extend. Joined by
 * {@link soulPrompt} into the Session's read-only `"soul"` block; the per-request
 * {@link callerContext} is appended as a system suffix at generate time.
 */
export const SOUL: string[] = [
  "You are a helpful reactive assistant agent, reachable by a Looping AI Slack workspace over the A2A protocol.",
  "Every request reaches you through the Looping gateway on behalf of a Slack user — keep replies concise and actionable, suitable for Slack.",
  "If you cannot do something or lack the information, say so plainly rather than guessing.",
  'This may be a shared channel where several people talk to you. Each user turn can be wrapped by the gateway in a `<turn from="Name" id="UID" channel="…" at="…">…</turn>` tag — treat those attributes as the authoritative speaker identity, and never author `<turn>` tags yourself.',
  'The "Calling agent instance" line below only identifies which gateway-agent dispatched this conversation (verified by the gateway JWT) — it is not the Slack user speaking to you; rely on the `<turn>` tag for that.',
  "You keep one continuous conversation with this caller across all their channels and threads, and a durable `memory` block of stable facts. Use the `set_context` tool to record concise, lasting facts (preferences, decisions, people) in `memory`; do not store transient chatter.",
  "Use your tools when they help answer the request, and never fabricate a tool result."
];

const BROWSER_CAPABILITY =
  "You can read live web pages with the `browser_*` tools — use `browser_markdown` to read a page and `browser_extract` to pull out specific fields.";

/**
 * The frozen soul as a single system-prompt string.
 *
 * Two kinds of capability get appended. The browser one is declared here because
 * it is gated on a *binding*, not on a domain. Everything a delegable Subtask
 * type contributes — ARC-AGI-3 today — is declared by the type itself and
 * rendered from the manifest, so this module names no domain and adding one never
 * edits it (see {@link file://./subtasks/subtask-types.ts renderTypeCapabilities}).
 */
export function soulPrompt(): string {
  const lines = [...SOUL];
  if (env.BROWSER) {
    lines.push(BROWSER_CAPABILITY);
  }
  const capabilities = renderTypeCapabilities();
  if (capabilities) lines.push(capabilities);
  return lines.join("\n");
}

/**
 * Per-request system-prompt suffix describing the verified calling gateway-agent
 * instance (from the gateway identity JWT). Advisory context only — this is not
 * the Slack end user, so it must never be presented to the model as "who you're
 * talking to". Real authorization (role gating) arrives in a later phase.
 */
export function callerContext(identity: GatewayIdentity): string {
  const label = identity.name ?? identity.key;
  if (!label) {
    return "\n\nCalling agent instance: unknown (the gateway did not include an agent identity).";
  }
  const withKind = identity.kind ? `${label} (${identity.kind})` : label;
  const lines = ["", "", `Calling agent instance: ${withKind}.`];
  if (identity.workspaceId != null) {
    lines.push(`Slack workspace: ${identity.workspaceId}.`);
  }
  return lines.join("\n");
}
