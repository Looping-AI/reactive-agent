import type { AgentCard } from "@a2a-js/sdk";

/**
 * The transport-independent half of this agent's {@link AgentCard} — everything
 * that does not depend on the request origin. {@link file://../a2a/card.ts}
 * `buildBaseCard` adds `supportedInterfaces` and the security scheme.
 *
 * Derived from the SDK `AgentCard` rather than hand-declared so a protocol field
 * that gains a requirement fails the build here instead of silently going
 * unadvertised.
 */
type AgentManifest = Pick<
  AgentCard,
  | "name"
  | "description"
  | "version"
  | "capabilities"
  | "defaultInputModes"
  | "defaultOutputModes"
  | "skills"
>;

export const manifest: AgentManifest = {
  name: "Reactive Agent",
  description:
    "Reference remote and reactive A2A agent for looping-gateway. Verifies the gateway " +
    "identity JWT, then answers the caller via a Workers-AI tool loop with a " +
    "durable per-caller memory (one continuous, self-compacting conversation).",
  version: "0.3.0",
  // `extensions` is a required (repeated) protobuf field in v1.0 — we declare no
  // protocol extensions, so it stays empty.
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description:
        "Chat with the caller using a Workers-AI model, calling tools when useful.",
      tags: ["chat", "assistant"],
      examples: [],
      // Empty means "inherit the card's defaultInput/OutputModes"; both skills
      // are plain text like the agent as a whole.
      inputModes: [],
      outputModes: [],
      // Empty means "inherit the card-level requirement" (the gateway JWT).
      securityRequirements: []
    },
    {
      id: "browse",
      name: "Browse the web",
      description:
        "Read and scrape live web pages — render a page as Markdown, extract structured data, or list its links.",
      tags: ["web", "browser"],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ]
};
