import type { RecipeExecutionRequest } from "@/agent/subtasks/types";

/**
 * Deterministic rendering of one subagent invocation. Pure — no model, no
 * Session, no lookups: everything comes verbatim from the request. The three
 * input categories stay clearly separated and labeled so tests (and the model)
 * can tell them apart: the main-agent instruction, the verbatim conversation
 * reference snapshots, and generated dependency output — which is explicitly
 * marked as generated and never presented as conversation evidence.
 */
export interface RenderedInvocation {
  /** The validated Recipe soul, verbatim — the invocation's system prompt. */
  system: string;
  /** The sectioned user message (instruction, references, dependency results). */
  prompt: string;
}

/**
 * Render the sectioned user message for one execution. Reference snapshots are
 * emitted exactly as captured at decomposition — `[ref N]` labels with the
 * message role, no summarizing, rewriting, or interpolation. Sections with no
 * content are omitted entirely.
 */
export function renderSubagentPrompt(
  request: RecipeExecutionRequest
): RenderedInvocation {
  const sections: string[] = [];

  const prompt = request.prompt.trim();
  if (prompt !== "") {
    sections.push(`# Task\n${prompt}`);
  }

  if (request.references.length > 0) {
    const refs = request.references.map(
      (ref, i) => `[ref ${i + 1}] (${ref.role}): ${ref.text}`
    );
    sections.push(
      "# Conversation references (verbatim snapshots of the caller's conversation)\n" +
        refs.join("\n")
    );
  }

  if (request.dependencyResults.length > 0) {
    const deps = request.dependencyResults.map((dep) => {
      const text = dep.resultParts.map((part) => part.text).join("\n");
      return `[dependency ${dep.subtaskId}] (${dep.type}): ${text}`;
    });
    sections.push(
      "# Dependency results (generated output from prerequisite subtasks — not conversation evidence)\n" +
        deps.join("\n")
    );
  }

  return { system: request.recipe.soul, prompt: sections.join("\n\n") };
}
