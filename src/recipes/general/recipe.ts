import {
  CHAT_MODEL_ID,
  CHAT_FALLBACK_MODEL_ID,
  DEFAULT_MAX_TURNS,
  DEFAULT_TURNS_PER_CHUNK,
  DEFAULT_CHUNK_SOFT_MS,
  DEFAULT_HISTORY_WINDOW
} from "@/config";
import type { ResolvedRecipe, SubtaskTypeSpec } from "@/recipes/types";
import { GENERAL_SUBAGENT_SOUL } from "./soul";

/** Semantic Subtask type for any self-contained unit of work with no domain. */
export const GENERAL_TYPE = "general";

/**
 * The general-purpose Recipe: the execution configuration for work that needs no
 * domain of its own.
 *
 * Model ids and limits come from {@link file://../../config.ts} so it always
 * reflects the current configuration — there is no DB seed to go stale. It
 * declares no params and knows nothing about the types it serves: that is
 * {@link GENERAL_SPEC}'s job.
 */
export const GENERAL_RECIPE: ResolvedRecipe = {
  key: GENERAL_TYPE,
  version: 1,
  primaryModelId: CHAT_MODEL_ID,
  fallbackModelId: CHAT_FALLBACK_MODEL_ID,
  soul: GENERAL_SUBAGENT_SOUL,
  toolFamilies: ["browser"],
  enabled: true,
  // maxTurns === turnsPerChunk ⇒ the general recipe always completes in a single
  // durable chunk, identical to the pre-resumable-runner behavior. historyWindow
  // exceeds maxTurns so a general run never prunes its own context.
  limits: {
    maxTurns: DEFAULT_MAX_TURNS,
    turnsPerChunk: DEFAULT_TURNS_PER_CHUNK,
    chunkSoftMs: DEFAULT_CHUNK_SOFT_MS
  },
  historyWindow: DEFAULT_HISTORY_WINDOW,
  reportMetrics: false
};

/** The general type: any self-contained unit of work, taking no params. */
export const GENERAL_SPEC: SubtaskTypeSpec = {
  key: GENERAL_TYPE,
  description:
    "Any self-contained piece of work: research, drafting, summarizing, reading a web page.",
  params: null,
  recipe: GENERAL_RECIPE
};
