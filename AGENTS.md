# AGENTS.md

Guidance for coding agents working in this repo. Keep it accurate — update it when the build, layout, or contract below changes.

## What this is

A deployable **reference remote and reactive (custom) A2A agent** for [looping-gateway](https://github.com/Looping-AI/looping-gateway), running as a single **Cloudflare Worker**. It demonstrates the zero-shared-secrets trust contract a third party must implement to be registered and routed to by the gateway. All trust flows through asymmetric **Ed25519 / EdDSA** signatures over public JWKS — there are no symmetric secrets in either direction.

Once the caller is verified, the Worker routes the call into a **`ReactiveAgent` Durable Object** — one instance per calling gateway-agent (keyed by the verified `identity.key`) — which owns the caller's **durable Session** (one continuous conversation + a self-edited `memory` block, backed by `this.sql`), compacting history on size. Messages displaced by compaction are embedded into **Vectorize** (per-instance namespace) for **episodic recall** — a `recall` tool semantically searches history that has scrolled out of the live window.

Every accepted Task runs a **round loop** in a durable Workflow: pre-work → a **round** (one main-agent inference that either answers the user or delegates 1-8 durable Subtasks) → **execute** the dependency-ready ones concurrently in isolated managed subagents → back to the next round, which sees the results and decides again → deliver. The agent is never forced either way: plain text is a terminal answer, `delegate` is a control tool, and only the last round of the budget is denied the choice. See "The round loop" in [ARCHITECTURE.md](ARCHITECTURE.md). The main agent's work tools are `browser_*` + gated `recall`, layered over the Session's own `set_context`; subagents get the `browser`/`workspace`/domain families from their Recipe. Per-call **authorization** policy for domain tools is a later phase. The enduring value is the zero-trust _contract_, which is independent of the agent's behavior.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full trust model and sequence diagrams, and [README.md](README.md) for setup/deploy/registration.

## Commands

```sh
npm install            # install deps
npm run dev            # wrangler dev (local Worker); press `t` for a quick tunnel
npm run test           # vitest run (whole suite in the Workers runtime via one cloudflareTest pool; hermetic — no network)
npm run test:watch     # vitest watch
npm run check          # wrangler types --check && prettier --check && eslint && tsc (src) && tsc (test)  ← CI + pre-commit gate
npm run lint           # eslint only
npm run format         # prettier --write .
npm run types          # regenerate worker-configuration.d.ts (wrangler types) — then commit it
npm run keygen <kid>   # generate an Ed25519 private JWK for A2A_SIGNING_KEY
npx drizzle-kit generate  # generate a new migration after editing src/db/schema.ts — then update src/db/migrations/index.ts
```

`npm run check` is the source of truth: it runs in CI ([.github/workflows/test.yml](.github/workflows/test.yml)) and as the husky `pre-commit` hook. Run `npm run check && npm run test` before committing — the commit will be rejected otherwise.

**Types come from a committed, generated [worker-configuration.d.ts](worker-configuration.d.ts)** — `wrangler types` produces full _runtime_ types tailored to `wrangler.jsonc`'s compat date / flags / bindings. This file (plus `@types/node`, because `nodejs_compat` is on) is the source of the ambient Workers globals (`Ai`, `DurableObjectNamespace`, `ExportedHandler`, `Request`, …); it replaced `@cloudflare/workers-types`. It's **committed to git** and referenced from `tsconfig.json` / `test/tsconfig.json` `types`. `npm run check` leads with `wrangler types --check` as a drift guard, so after any `wrangler.jsonc` binding change or a wrangler/workerd bump (incl. dependabot's cloudflare group), run `npm run types` and **commit the regenerated file** or the gate fails.

## Reading production logs

Read the **deployed** Worker's logs (and all sibling Workers in the account) through `scripts/cf.mjs`, a credential proxy: it reads `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `.env.local` (gitignored; see [.env.local.example](.env.local.example)) and calls the Cloudflare API, so the token never reaches the terminal or an agent's context. Token scopes needed: **Workers Observability: Read** (logs) and **Workers Scripts: Read** (workflow state — there is no standalone "Workflows" scope).

```sh
node scripts/cf.mjs verify                                   # or: npm run cf -- verify
node scripts/cf.mjs logs --since 2h --level error            # digest of recent errors
node scripts/cf.mjs logs --worker looping-reactive-agent --grep executeChunk
node scripts/cf.mjs wf handle-task                           # list workflow instances
node scripts/cf.mjs wf handle-task <instanceId>              # per-step pass/fail
node scripts/cf.mjs --help                                   # all subcommands + flags
```

- `logs` prints a compact digest (`--json` / `--raw` for the full payload) and spans **all** Workers in the account (`looping-gateway`, `looping-proactive-agent`, …), not just this one — hence "logs sometimes live elsewhere."
- **Gotcha — workflow "errors" are usually noise.** A telemetry event with `outcome: exception` on a Workflow is the runtime _suspending between steps by throwing_, not a failure. Confirm with `wf <name> <instanceId>` and read the instance's `status` / `error` before trusting it. Likewise the `RecipeSubagent.executeChunk` exceptions are usually the recoverable first leg of the fingerprint-mismatch retry in [executeChunkInChild](src/reactive-agent/index.ts) — a real failure only on a second mismatch.
- An uncaught exception's **stack is not carried in telemetry** (only the console log label), so an `error`-level event with no detail is expected — pivot to `wf` / instance state for the real cause.

Then: group the errors, map each to its source in `src/`, and propose/apply fixes.

## Non-negotiable constraints

These are the things that silently break the contract or the trust model. Treat them as invariants.

1. **`src/a2a/canonical.ts` must stay byte-for-byte identical to the gateway's** `src/a2a/card-verify.ts` canonicalizer (keys sorted recursively ascending, `JSON.stringify` no whitespace, `signatures` excluded, base64url no padding). The gateway recomputes the signed payload independently; any deviation makes signatures fail to verify. **If you change one, change both.** Don't "improve" the serialization.

2. **Algorithm is `EdDSA` (Ed25519) everywhere** — card signing, gateway JWT verification, key generation. Reject/forbid anything else. The constant `ALG = "EdDSA"` appears in `src/a2a/card.ts` and `src/a2a/verify.ts`; keep them in lockstep.

3. **Never weaken the JWT verification in `src/a2a/verify.ts`.** It enforces, in order: `jku` header present → `jku` origin ∈ `GATEWAY_ORIGINS` → `iss` origin === `jku` origin → `jwtVerify` with `issuer`/`audience`/`algorithms`. The `jku`-origin allowlist and the `iss`===`jku` check prevent key-injection and cross-gateway impersonation. Do not skip a check, widen the allowlist to wildcards, or fetch a `jku` before validating its origin.

4. **Zero shared secrets.** Only public JWKS cross the boundary. The single private key (`A2A_SIGNING_KEY`) never leaves the Worker; only its public half is served at `/.well-known/jwks.json`. Never log, echo, or commit a private JWK or the `d` field.

5. **`GATEWAY_ORIGINS` (Worker secret) must match the deployed gateway's `GATEWAY_ORIGIN`.** It's a JSON array string, e.g. `["https://gw.example.com"]`. It validates both the JWT `jku` and `iss`.

6. **References are snapshotted when a round delegates, and never re-resolved.** The model selects catalog **indices** from that round's own catalog; application code copies the selected message's exact role+text onto the Subtask row. Never let model output become reference text, and never re-read the Session at execution time — that's what stops a rewritten "quote" reaching a subagent, and what makes mid-task compaction unable to affect a Subtask in flight. Summaries, recall results, and generated dependency output must never be presented as original conversation evidence.

7. **Delete a managed child only _after_ its terminal result is durably copied into the parent.** Deleting first loses the result. Which direction you're in is decided by the guarded `pending -> running` claim: winning it means a fresh execution (delete any stale child first), losing it with the row still `running` means a crashed attempt is being retried (**don't** delete — the child's fingerprint cache may hold the terminal result that makes the retry free).

## Runtime & style

- **Cloudflare Workers runtime**, not Node. `nodejs_compat` is on, but prefer Web APIs (`crypto`, `fetch`, `Response.json`, `TextEncoder`). Crypto goes through [`jose`](https://github.com/panva/jose). `@types/node` is installed (for tooling/config like `vitest.config.ts`) — it will happily type Node built-ins that aren't in the Workers runtime, so it won't catch a Node API creeping into Worker code; that's on you.
- The agent runtime is a **Durable Object** on the [`agents`](https://github.com/cloudflare/agents) SDK `Agent` base. Reach it only via a DO stub with **native Cloudflare RPC** — never `routeAgentRequest`, and **never re-implement an internal HTTP/JSON-RPC layer on top of the DO**: it's a private implementation detail, not a network-reachable service, so the one real A2A server lives in the Worker (`src/index.ts`) and the DO just exposes plain async methods. Resolve the stub through [`getAgent`](src/reactive-agent/index.ts) (routing only — no cast: the DO's `Task`-returning methods return [`PlainTask`](src/a2a/task.ts), which sidesteps the `never` collapse raw `Task` returns would cause). Use `this.sql` for the Session — **do not override the DO `alarm()`** (the `Agent` base owns it). Sessions live under `agents/experimental/memory/*`.
- **Schema migrations** follow the Agents SDK pattern: `AgentDB`'s constructor ([src/db/db.ts](src/db/db.ts)) runs `migrate()` from `drizzle-orm/durable-sqlite/migrator`, and `ReactiveAgent.onStart()` forces that construction (`void this.db`) on every instance wake-up (idempotent — Drizzle tracks applied migrations in `__drizzle_migrations`). Because every DO instance has its own private SQLite, there is no global `wrangler d1 execute`-style apply step; each instance self-migrates. Constructing `AgentDB` directly (via the DO's `db` getter) also migrates, which keeps `runInDurableObject`-based tests working without triggering `onStart()`. To evolve the schema: edit `src/db/schema.ts` → run `npx drizzle-kit generate` → copy the new SQL into `src/db/migrations/index.ts` following the file's instructions.
- **Async A2A (accept + notify).** Remote agents reply asynchronously: the Worker accepts a `message/send` with a `submitted` Task and delivers the reply later by POSTing the completed Task to the gateway's `pushNotificationConfig.url` (`/a2a/notifications`). Generation + delivery run in a **Cloudflare Workflow** ([`HandleTaskWorkflow`](src/workflows/handle-task.ts)) — a separate entrypoint that **cannot touch the DO's SQLite directly**, so turn inputs travel as the workflow payload and task state is mutated only through DO RPC. Test `runHandleTask(params, step)` directly (workerd forbids constructing a `WorkflowEntrypoint` outside the runtime). **The Subtask rows are the source of truth; Workflow state is not** — a `step.do` return is capped at **1 MiB** and a Subtask carries verbatim reference snapshots bounded only by `MAX_INBOUND_TEXT_BYTES` (256 KB), so steps return narrow projections (`SubtaskNode`), never rows. Every phase recovers by re-reading the database and the Session, which is what makes replay safe. The callback JWT reuses the card's `A2A_SIGNING_KEY`/`kid`/`jku` — keep it in lockstep with `src/a2a/card.ts`; still zero shared secrets. An outbound signed `fetch` to the gateway is fine (it does not make the DO/workflow a network-reachable server).
- TypeScript is `strict`. ESLint forbids `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-deprecated` (both `error`). Prefix intentionally-unused vars with `_`.
- Prettier with `trailingComma: "none"`. Run `npm run format`; don't hand-format.
- Module entry is `satisfies ExportedHandler<Env>` and re-exports the `ReactiveAgent` DO class (Cloudflare resolves the `class_name` from the entry exports); bindings and secrets are typed via the `Env` interface in [worker-configuration.d.ts](worker-configuration.d.ts) (generated; includes `AI`, `VECTORIZE`, `ReactiveAgent`, `A2A_SIGNING_KEY`, `GATEWAY_ORIGINS`).

## Tests

- The **whole suite runs in the Workers runtime** (workerd via miniflare) through a **single `cloudflareTest()` pool** (config: [vitest.config.ts](vitest.config.ts)). The plugin registers the `cloudflare:test` virtual module (→ `env`, `runInDurableObject`, `runDurableObjectAlarm`, `introspectWorkflow`) and reads **`wrangler.jsonc` directly** (`wrangler: { configPath }`), so bindings added there (e.g. `VECTORIZE`) are picked up automatically — only the two secrets kept out of `wrangler.jsonc` are supplied inline. Neither `AI` nor `VECTORIZE` has a local mode (both print a startup warning and fail-fast on use), so specs inject fakes rather than hitting them. **`remoteBindings: false` is passed explicitly** (not left default): the `AI` binding otherwise makes every test file eagerly open a remote connection at startup (~15-20s + a teardown hang). Three tiers:
  - _Agent runtime_ (`test/agent/**`): drive the round operation (`turn.spec.ts`), prompt, tools, messages, Session helpers, and the pure `subtasks/**` modules (catalog, decomposition, recipe, scheduler) against an **injected mock model** ([test/agent/mock-model.ts](test/agent/mock-model.ts)) + a fake `SessionLike` ([test/helpers/fake-session.ts](test/helpers/fake-session.ts)), so they unit-test without a real Session or `AI`. Error-path tests inject failure by **throwing synchronously from the model factory** (`primary: () => { throw }` — see `turn.spec.ts` / `subagent/run.spec.ts`) — _not_ by passing a model whose `doGenerate` rejects into `generateText`, which leaks an unhandled rejection through the AI SDK telemetry span that workerd flags as a failure.
  - _Subagent_ (`test/subagent/**`): `prompt.ts` rendering (soul as system; references and dependency output kept distinct), `fingerprint.ts` determinism, `run.ts` primary/fallback + transient-vs-terminal, and the real facet lifecycle in `subagent.spec.ts` (create/list/delete, cache reuse, `FINGERPRINT_MISMATCH`).
  - _Entrypoint + auth_ (`test/index.spec.ts`, `test/a2a/**`): drive the outer Worker's own logic. `index.spec.ts` covers auth/card/JWKS paths with a stub `env` (no real AI or DO needed). The DO-routing test passes through the **real miniflare `ReactiveAgent` DO** — the executor uses `import { env } from "cloudflare:workers"` rather than the handler's `env` param, so no fake namespace is injected; the turn fails gracefully (AI unavailable) and the test asserts a well-formed 200 agent response. The thin `A2AExecutor` has no spec of its own; `index.spec.ts` is its coverage.
  - _Real-DO integration_ (`test/reactive-agent/*.spec.ts`, `test/db/*.spec.ts`): drive the **real** `ReactiveAgent` DO via `env.ReactiveAgent` and `runInDurableObject`, against real SQLite. `reactive-agent.spec.ts` covers the Session + task state; `subtasks-rpc.spec.ts` covers the pipeline RPCs (execution lifecycle ordering via `vi.spyOn(instance, "subAgent"|"deleteSubAgent")` + `mock.invocationCallOrder`, retry/recovery, cancellation) and drives **real** `RecipeSubagent` facets. `env.AI.run()` throws "needs to be run remotely" immediately (no network) — which is exactly why the real-facet case can only prove the _failure_ path: the child exhausts both models. A real facet cannot be made to **succeed** hermetically, because `modelsOverride` is a field and never crosses the RPC stub.
  - _Workflow_ (`test/workflows/handle-task.spec.ts`): drive `runHandleTask(params, step)` with a fake `step` (recording names, and replaying from a shared cache to simulate replay) and a fake DO that owns a **real in-memory DAG**, so wave ordering, skip propagation, and fan-out are exercised rather than scripted. Assert the exact durable **step-name sequence** — those names are cache keys.
- The suite is **hermetic**: `MockAgent` with `disableNetConnect()` makes any unmocked outbound request throw (only the gateway JWKS fetch is intercepted); the LLM is either a mock model ([test/agent/mock-model.ts](test/agent/mock-model.ts)) or the fail-fast local `AI` binding; dependencies are injected, never module-mocked (there is no `vi.mock` in the suite). Don't add real network/inference calls in tests.
- **Split pure logic from AI-SDK / DO wiring** so it unit-tests without an LLM or a real Session (e.g. the `recall` handler, `parseTurn`, `archivingCompaction`, `selectWave`, `resolveDecomposition`, `renderTurnMessages`, `validateRecipe`, `renderSubagentPrompt`); drive the operations with `mockModel(...)` (or a `ModelPair` that throws from its factory for error paths), the `ModelOverrides` hook, and a fake `SessionLike`. `FakeSession` mirrors the two real behaviors the round loop depends on: `appendMessage` **dedupes by message id** (which is what makes each round's append exactly-once on a step re-run), and `getMessage` reads the stored text back.
- Test keys and `makeGatewayToken(...)` live in [test/fixtures.ts](test/fixtures.ts). Build gateway tokens through that helper so headers/claims stay consistent.
- The **test-only `RECIPE_SUBAGENT` DO binding** (miniflare override in [vitest.config.ts](vitest.config.ts), typed by [test/env.d.ts](test/env.d.ts)) exists because the pool only treats bound classes as facet-compatible; production needs no binding for `RecipeSubagent`. Keep it out of `wrangler.jsonc` and `new_sqlite_classes`.
- When adding a route or verification branch, cover it with both an accept and a reject case (mirror the existing `test/a2a/verify.spec.ts` / `test/index.spec.ts` style).

## Secrets

- `A2A_SIGNING_KEY` — Ed25519 private JWK (must include `kid`). Locally in `.dev.vars` (gitignored; see [.dev.vars.example](.dev.vars.example)); in prod via `wrangler secret put A2A_SIGNING_KEY`. Generate with `npm run keygen <kid>`. Never commit it.
- `GATEWAY_ORIGINS` — JSON array of trusted gateway origins, e.g. `["https://gw.example.com"]`. Not sensitive, but kept in `.dev.vars` locally and `wrangler secret put GATEWAY_ORIGINS` in prod (rather than `wrangler.jsonc` vars) so it can be changed per-deploy without a code change.
- `ARC_API_KEY` — ARC-AGI-3 API key (from the ARC-AGI-3 web console), used by the `arc-game` recipe's tool family. Same `.dev.vars` / `wrangler secret put` flow.

## Note on `.agents/skills/`

That directory holds vendored Cloudflare skill packs (tracked in `skills-lock.json`) — reference material, not application code. Don't edit those files by hand.
