import type { AgentCapabilities, AgentSkill } from "@a2a-js/sdk";

interface AgentManifest {
  name: string;
  description: string;
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

export const manifest: AgentManifest = {
  name: "Proactive Agent",
  description:
    "Reference remote and proactive A2A agent for looping-gateway. Verifies the gateway " +
    "identity JWT, then answers the caller via a Workers-AI tool loop with a " +
    "durable per-caller memory (one continuous, self-compacting conversation).",
  version: "0.3.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description:
        "Chat with the caller using a Workers-AI model, calling tools when useful.",
      tags: ["chat", "assistant"]
    },
    {
      id: "browse",
      name: "Browse the web",
      description:
        "Read and scrape live web pages — render a page as Markdown, extract structured data, or list its links.",
      tags: ["web", "browser"]
    }
  ]
};
