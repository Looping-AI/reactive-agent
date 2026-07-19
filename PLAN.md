# PLAN — Generic Resumable Runner + Workspace + ARC AGI 3 Recipe

> Supersedes the completed "Phased Task Recipes and Subagents" plan (preserved in
> git history). That plan's durable rationale lives in `ARCHITECTURE.md` and
> `AGENTS.md`.

## Context

Two goals, one design:

1. **Capability**: play ARC AGI 3 games (https://three.arcprize.org) when a Slack user asks ("play game ls20") — a long, stateful, non-idempotent loop of LLM turns + external REST calls that cannot fit today's subtask shape (a single 8-step `generateText` inside one ~10-min workflow step).
2. **Architecture**: solve it with **general machinery, not an ARC special case**. One runner for every recipe, customizable through recipe config (turn budgets, chunking, context policy). Domain behavior lives entirely in **tool families**; durable run state lives in a **workspace** (file-like read/write store) owned by the recipe's tools and the model. ARC is merely the first domain folder under `src/recipes/`, and the proof the seam generalizes.

There is deliberately **no** "single vs. game" execution discriminator anywhere: every subtask runs through the same chunked runner; a default recipe simply completes in its first chunk.

### Decisions (fixed)

- ARC play is **uncapped** until WIN/GAME_OVER — but fully **tracked**: wall-clock time, turns, LLM calls recorded and reported. A distant safety ceiling via recipe `limits.maxTurns` (20,000 for ARC) → terminal "budget exhausted" with full metrics.
- Slack progress: post on each level-up + final summary (existing `postWorking` machinery, driven generically by tool-emitted progress events).
- Model: repo default pair (`@cf/zai-org/glm-5.2` / gemma fallback). Recipes stay code-only; recipe _data_ tables remain out of scope (prior plan's decision stands — `src/recipes/<domain>/` is code organization, not a registry).

### Workspace: what Cloudflare offers (verified)

- The core Agents SDK exposes `this.state` (JSON) and `this.sql` (per-instance SQLite) — no file API of its own.
- **`@cloudflare/shell`** (v0.4.x, same `cloudflare/agents` monorepo) is a filesystem runtime for Workers agents: a `Workspace` class backed by the DO's own SQLite (`new Workspace({ sql: this.ctx.storage.sql, name: () => this.name })`) with **optional R2 for large files**; full fs API (`readFile`/`writeFile`/`appendFile`/`mkdir`/`rm`/`cp`/`mv`/`readdir`/`glob`/`stat`/`exists`), JSON ops (`readJson`/`queryJson`/`updateJson`), search/replace, and transactional `applyEdits({ rollbackOnError })`; plus `createGit()` (isomorphic-git over the virtual fs) and sandboxed JS execution via `@cloudflare/codemode`. **Works with any Agent class — no Think dependency.**
- **`@cloudflare/think`** is an opinionated _chat_ agent (agentic loop, stream resumption, client tools) that integrates shell — evaluated and **not adopted**: our `RecipeSubagent` is a headless, Workflow-driven, fingerprint-cached RPC facet, not a chat host; Think's loop/persistence model would fight the A2A pipeline. Shell standalone is the right integration.
- **Sandbox SDK** (container Linux fs) remains wrong-fit for per-task state files; DO SQLite limits (10 GB/object, 2 MB/value) apply to sql-backed files — R2 config lifts that if ever needed.

**Chosen**: `@cloudflare/shell`'s `Workspace` instantiated in the `RecipeSubagent` facet over `this.ctx.storage.sql` — per-subtask isolation is free (one facet per subtask) and `deleteSubAgent` wipes the facet's storage, workspace included. Because shell is explicitly _"Experimental — expect breaking changes"_, we pin the version and code tool families against a **narrow `WorkspaceHandle` wrapper** (read/write/list/readJson/updateJson) rather than the full shell surface; shell's `stateTools()` are codemode ToolProviders, so the model-facing tools are our own thin ai-SDK `tool()` wrappers over the same fs. Peer-dep compat verified (`agents >=0.12.4`; repo has `^0.17.4`).

### Verified ARC API facts

- Base `https://three.arcprize.org`, header `X-API-Key`. **AWSALB\* cookies must be manually echoed** per session (Workers fetch has no cookie jar; `Headers.getSetCookie()` exists).
- Scorecard paths are **singular**: `POST /api/scorecard/open` → `{card_id}`, `POST /api/scorecard/close` (card_id in body), `GET /api/scorecard/{card_id}`.
- `POST /api/cmd/RESET {game_id, card_id, guid?}` (omit guid = new session; with guid = level reset — never use for resync). `POST /api/cmd/ACTION1..5,7 {game_id, guid, reasoning?}`; `ACTION6` adds `x, y` (0–63). `reasoning` is a JSON object ≤16 KB.
- Semantics: ACTION1–4 = up/down/left/right, ACTION5 = interact/select, ACTION6 = click(x,y), **ACTION7 = undo**.
- Response: `{game_id, guid, frame: number[][][] (64×64 grids, cells 0-15), state: NOT_FINISHED|NOT_STARTED|WIN|GAME_OVER, levels_completed, win_levels, available_actions}`. Rate limit 600 RPM → 429 + backoff.
- `GET /api/games` → `[{game_id, title}]`; ids like `ls20-016295f7601e` — the tool resolves the user's "ls20" prefix.
- **No read-only "current frame" endpoint** — drives the write-ahead-intent design in the ARC tools.

### Platform facts

Workflows paid plan: **10,000 steps/instance**, instance duration unlimited, `step.do` default ~10-min timeout with `{limit: 5, exponential}` retries. Chunking (≤ ~4 min each) is itself the timeout mitigation, so we keep the repo's "no speculative `StepConfig`" stance.

## Architecture

```
HandleTaskWorkflow — recipe-agnostic:
  runBranch(id):
    for chunk = 0, 1, 2, …  (global MAX_CHUNKS_PER_BRANCH cap)
      step.do(chunk === 0 ? `execute:<id>` : `execute:<id>:chunk:<chunk>`)
        → DO.executeSubtaskChunk(id, chunk, push)     [posts progress events]
          → facet.executeChunk(request, chunk)         [RecipeSubagent]
            → runResumableChunk(…)                     [ONE generic runner]
                agentic tool loop; per-step persistence; workspace-backed state
      until outcome.done
```

- **Step-name unification**: chunk 0 is named `execute:<id>` — byte-identical to today for every recipe that completes in one chunk (the default recipe always does, since `turnsPerChunk === maxTurns === 8`). No in-flight-replay hazard, existing handle-task step-name assertions stay meaningful. Later chunks append `:chunk:<n>`.
- **Recipe config** (`ResolvedRecipe`): `limits: { maxTurns, turnsPerChunk, chunkSoftMs }` + `historyWindow` (steps kept verbatim in the rolling message history). Defaults reproduce today exactly (`maxTurns: 8`, single chunk). The workflow reads none of it — the DO/facet enforce budgets; the workflow just loops until done under a global cap.
- **Generic runner** (`runResumableChunk`, evolution of `src/subagent/run.ts`): an agentic `generateText` tool loop that is resumable:
  - Run state (rolling `ModelMessage[]` window + metrics) persisted in a facet `run_state` table **after every step** (`onStepFinish`) — a crash/retry loses at most the in-flight step.
  - Chunk ends on: natural completion (final text, no tool calls) · `turnsPerChunk` steps · `chunkSoftMs` soft clock · a progress event · `maxTurns` exhausted.
  - Context policy: each chunk prompts with system + task prompt + last `historyWindow` steps; older steps are pruned. The soul contract: _anything worth keeping beyond the window must be written to workspace files._
  - Budget exhaustion → one final no-tools summarization call → completed result labeled "budget exhausted", with metrics.
  - Metrics (turns, llmCalls incl. fallback, wall-clock) tracked generically; the runner appends a metrics footer to the final result text.
  - Primary→fallback per chunk, `maxRetries: 0`, transient errors throw (step retries; run state resumes) — all the existing `run.ts` disciplines.
- **Workspace** (`src/subagent/workspace.ts`): a narrow `WorkspaceHandle {read, write, list, delete, readJson, updateJson}` wrapping `@cloudflare/shell`'s `Workspace` (backed by the facet's `ctx.storage.sql`). Exposed two ways: programmatically to tool-family factories, and as a model-facing `workspace` tool family (`ws_read`/`ws_write`/`ws_list` — our own ai-SDK `tool()` wrappers, since shell's `stateTools()` target codemode). Cheap caps (per-file size, file count) guard the 2 MB DO row limit; R2 config on the shell `Workspace` is the large-file path if ever needed.
- **Tool-family contract** (extended, in `src/agent/tools.ts`): a family factory receives `{ env, workspace, emitProgress }` and returns `{ tools, abort? }`:
  - `emitProgress(text, key)` — runner ends the chunk after the emitting step; the chunk outcome carries the events; the parent DO posts them via `postWorking` with stable keys (gateway dedupes). Generic Slack progress for any domain.
  - `abort(workspace, env)` — reconstructible cleanup run by the facet's `abortExecution` on cancellation (ARC: read `arc/session.json`, close the scorecard).
- **ARC as a pure tool family** (`src/recipes/arc-game/`): `arc_start_game({game})` (list → prefix-resolve → open scorecard → RESET; unknown game → tool result listing available games), `arc_act({action, x?, y?, note})` (validates against `available_actions`; returns compact outcome: cells-changed diff, level, state, available_actions — not the raw grid), `arc_inspect({view})` (full hex render / region / histogram / components on demand). All session state — cookies, guid, card_id, write-ahead intent, level trajectory — lives in `arc/session.json` + `arc/log.jsonl` in the workspace. Level-up → `emitProgress`. Duplicate-move guard: intent written before the fetch, confirmed after; an unconfirmed intent on the next call is annotated "possibly duplicated (crash recovery)" — accepted residual risk (no reconcile endpoint exists).

**Trade-off, stated honestly**: vs. a scripted per-turn loop, the agentic runner gives the model freedom (it may dither or over-inspect), costing some turn-efficiency. That is the price of a domain-agnostic runner, mitigated by soul guidance, `historyWindow` pruning, and the turn budget — and it is ship-and-observe territory, not up-front engineering.

Decomposition-side limits (`MAX_SUBTASKS`) stay global — recipe config governs execution, not decomposition.

---

## Phase 1 — Recipe config: `limits`, `historyWindow`

- `src/agent/subtasks/types.ts` — `ResolvedRecipe` gains `limits: {maxTurns, turnsPerChunk, chunkSoftMs}` and `historyWindow`; add `SubtaskChunkOutcome {done, status, progress: ProgressEvent[]}`.
- `src/agent/subtasks/registry.ts` — `DEFAULT_RECIPE` gets today-equivalent limits (`maxTurns: MAX_STEPS`, `turnsPerChunk: MAX_STEPS`); `validateRecipe` clamps/normalizes (positive ints, `turnsPerChunk ≤ maxTurns`).
- `src/subagent/fingerprint.ts` — `canonicalRequest` rebuilds the recipe field-by-field: add the new fields (they'd silently vanish otherwise). Deploy note: fingerprint change → ≤1 self-healed `FINGERPRINT_MISMATCH` per in-flight retry.

Tests: extend `test/agent/subtasks/registry.spec.ts`, `test/subagent/fingerprint.spec.ts`.
**Done when:** `npm run check` + suite green; zero behavior change.

## Phase 2 — Workspace

- Add dependency `@cloudflare/shell` (pinned exact version — experimental API).
- `src/subagent/workspace.ts` — narrow `WorkspaceHandle` wrapper over shell's `Workspace` (instantiated in the facet with `{ sql: this.ctx.storage.sql, name: () => this.name }`); size/count caps. The wrapper is the only import surface for shell — tool families and the runner never touch shell types directly (contains experimental churn).
- `src/agent/tools.ts` — extend the tool-family contract to `{env, workspace, emitProgress} → {tools, abort?}` (the `browser` family adapts trivially, ignoring the new inputs); add the `workspace` family (`ws_read`/`ws_write`/`ws_list` as ai-SDK `tool()` wrappers — shell's `stateTools()` are codemode ToolProviders, not usable directly in our `generateText` loop); add `"workspace"` to `KNOWN_TOOL_FAMILIES` in recipe.ts.

Tests: new `test/subagent/workspace.spec.ts` (CRUD via the handle, caps, per-facet isolation); tools wiring in existing tool specs. Verify shell's SQLite tables live in facet storage so `deleteSubAgent` wipes them (extend the existing storage-wipe spec).
**Done when:** workspace usable from a facet in tests; storage-wipe spec proves cleanup; suite stays hermetic (shell over local SQLite needs no network).

## Phase 3 — Generic resumable runner

- `src/subagent/run.ts` — evolve `runRecipeExecution` into `runResumableChunk(request, chunk, deps)`: rolling-window message persistence (`run_state` table, after every step), chunk-end conditions, context pruning to `historyWindow`, budget-exhaustion summarization, generic metrics + result footer, progress-event collection. Single-chunk recipes exercise the same code path and finish at chunk 0.
- `src/subagent/index.ts` — `executeChunk(request, chunk): Promise<ChunkResult>` (fingerprint identical every chunk — `chunk` is a separate RPC arg; cached terminal replays as done; `execution_cache` written before returning done) and `abortExecution()` (run recipe families' `abort` hooks). Amend the "stateless" doc comment (per-execution durable state, wiped by `deleteSubAgent`).

Tests: `test/subagent/run-resumable.spec.ts` with mock models — chunk-end conditions, per-step persistence + resume, pruning (old steps absent, workspace persists), budget exhaustion, progress ends chunk, metrics footer; existing `run.spec.ts` cases ported (fallback, transient vs deterministic, empty prompt).
**Done when:** a multi-chunk mock run resumes losslessly across `executeChunk` calls; single-chunk behavior matches today's specs.

## Phase 4 — DO + workflow seam

- `src/reactive-agent/index.ts` — extract the shared front half of `executeSubtask` (~lines 410–480: load, terminal sweep, cancel check, recipe resolve/validate, guarded claim + fresh-vs-retry delete, request assembly); add `executeSubtaskChunk(id, chunk, push?: TurnPushContext): Promise<SubtaskChunkOutcome>`: chunk ≥1 lands in the existing "running — don't delete the child" branch; call `child.executeChunk` through the `executeInChild` mismatch-recovery pattern; post returned progress events via private `postWorking` (`push` as RPC param — the `decomposeTask` precedent); on done → cancel re-check, `persistResult`, `deleteSubAgent`; on cancel → `child.abortExecution()` best-effort, then delete. `executeSubtask` is refactored away (workflow moves to the chunk RPC; its specs port over).
- `src/workflows/handle-task.ts` — `runBranch` loops `step.do(chunk === 0 ? \`execute:${id}\` : \`execute:${id}:chunk:${chunk}\`, …)`until`outcome.done`, bounded by a global `MAX_CHUNKS_PER_BRANCH`(config const ~1,500; comment the arithmetic vs the 10,000-step platform limit); existing catch →`fail:<id>` applies per chunk unchanged. No recipe knowledge in the workflow. Cancellation: unchanged wave-scan + per-chunk DO check (mid-chunk cancel lands at chunk end, ≤ ~5 min).

Tests: port/extend `test/reactive-agent/subtasks-rpc.spec.ts` (lifecycle ordering: claim+delete chunk 0 only, no delete between chunks, delete after terminal persist, cancel → abort → delete) and `test/workflows/handle-task.spec.ts` (single-chunk nodes keep the exact current step sequence; a multi-chunk node drives `execute:1`, `execute:1:chunk:1..n`, stops on done; retry-exhausted chunk → `fail:1`).
**Done when:** full suite green; single-chunk step sequences byte-identical to today.

## Phase 5 — ARC AGI 3 domain (`src/recipes/arc-game/`)

- `client.ts` — typed fetch client, explicit cookie-jar in/out, 429/5xx backoff (honor Retry-After, injected sleep), 401 tagged error, singular scorecard paths.
- `analysis.ts` — pure: `renderGridHex`, `diffGrids`, `colorHistogram`, `connectedComponents`, `describeFrame`.
- `tools.ts` — the `arc-game` tool family (`arc_start_game`, `arc_act`, `arc_inspect`) + `abort` hook; session state + write-ahead intent in workspace files; level-up → `emitProgress`.
- `soul.ts` — `ARC_GAME_SOUL`: rules, action semantics, hypothesis/scratchpad discipline _in workspace files_ (history is pruned), turn economy (prefer acting over re-inspecting), end-of-game reporting contract.
- `recipe.ts` — `ARC_GAME_RECIPE`: default model pair, `toolFamilies: ["workspace", "arc-game"]`, `limits: {maxTurns: 20_000, turnsPerChunk: 25, chunkSoftMs: 240_000}`, `historyWindow: ~12`.
- `src/agent/subtasks/registry.ts` — `resolveRecipeForType("arc-game")` → `ARC_GAME_RECIPE`; add `"arc-game"` to `KNOWN_TOOL_FAMILIES`.
- `src/agent/decompose.ts` — teach `DECOMPOSITION_INSTRUCTIONS`: an ARC play request → exactly one subtask, `type: "arc-game"`, no fan-out/deps, game identifier verbatim in the prompt, runs long.
- Secret: `"ARC_API_KEY"` in `wrangler.jsonc` `secrets.required`; `.dev.vars.example` + README line; `npm run types`.

Tests: `test/recipes/arc-game/{client,analysis,tools}.spec.ts` (cookie echo, backoff, paths; grid helpers; tool behavior over a fake client + in-memory workspace: start/resolve/unknown-game listing, act validation, intent write-ahead + duplicate annotation, level-up progress emission, abort closes scorecard).
**Done when:** hermetic suite green; optional untracked live-API smoke confirms endpoints + cookie affinity.

## Phase 6 — Docs + end-to-end (ship and observe)

- ARCHITECTURE.md: resumable-runner + workspace + tool-family contract sections; Known-risks additions (agentic turn-efficiency; duplicate-move residual window). AGENTS.md: `src/recipes/<domain>/` layout, chunk step names, secrets line.
- Local e2e: `ARC_API_KEY` in `.dev.vars`, `npx wrangler dev --tunnel`, register with the gateway, Slack "play game ls20" → observe one `arc-game` subtask, chunk cadence, level-up posts, final summary with turns/llmCalls/wall-time.
- First-deploy checklist: AI Gateway logs (tool-call quality, dithering, fallback rate); Workflows dashboard (steps/chunk durations/retries); scorecard UI (actions recorded, closed on terminal); one deliberate mid-game cancel (row → canceled, scorecard closed); watch for duplicate-move annotations and post-deploy `FINGERPRINT_MISMATCH` (≤1 per in-flight retry).

## Documented risks (guards, not engineering)

- Duplicate move in the crash window between intent-write and confirmation (annotated; no reconcile endpoint).
- Unclosed scorecard if a branch hard-fails with the child unreachable.
- glm-5.2 agentic tool-call quality over thousands of turns (dithering, malformed calls) — observable via metrics footer + AI Gateway; tune soul/limits with evidence.
- Rolling-window pruning loses context the model failed to persist — the soul contract is the guard; observe before adding machinery.
- Step-budget arithmetic (`MAX_CHUNKS_PER_BRANCH` ~1,500 vs 10,000 platform limit).
- `@cloudflare/shell` is experimental ("expect breaking changes") — pinned exact version + the narrow `WorkspaceHandle` wrapper contain the blast radius of upgrades.

## Explicitly Out of Scope

- Recipe DB tables / admin surface (unchanged).
- R2-backed workspace files (a shell `Workspace` config option — enable when a domain needs >2 MB files).
- shell's codemode sandboxed-JS execution (needs a LOADER binding) and `gitTools` — natural follow-ups on the same lib (e.g. model-written grid-analysis code, git-versioned workspaces), not v1.
- `@cloudflare/think` — chat-host agent; wrong fit for the headless Workflow-driven facet.
- Multiple concurrent games per subtask; parallel tasks work naturally.
- Non-text result parts; workspace files do not outlive the subtask.
