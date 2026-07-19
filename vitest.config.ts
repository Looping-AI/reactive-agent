import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { existsSync } from "node:fs";
import path from "path";
import {
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatewayPublicJwks
} from "./test/fixtures";
import { createVcrAgent } from "./test/helpers/vcr";

// Real secrets for `npm run test:record` (`RECORD=1 vitest run recorded.spec.ts`
// — see package.json), loaded from a local, gitignored .env.test (see
// .env.test.example) so recording never requires pasting a key on the shell.
// Values already in process.env (CI/shell) win — Node's loader never
// overwrites an existing var. A no-op when the file is absent: ordinary
// playback runs use the `??=` test-fixture defaults below.
const ENV_TEST = path.resolve(import.meta.dirname, ".env.test");
if (existsSync(ENV_TEST)) process.loadEnvFile(ENV_TEST);

// `RECORD=1` makes every activated cassette capture real traffic; every other
// run replays. Generic — recorded specs key their own cassettes per test, so
// this flag and `test:record` stay recipe-agnostic as more specs are added.
const RECORD = !!process.env.RECORD;

// One agent serves the whole suite (Miniflare allows only a single `fetchMock`).
// It record/replays per-test cassettes (announced by each recorded spec over an
// in-band control channel — see test/helpers/vcr.ts), while ordinary MockAgent
// interceptors (the gateway JWKS) and `disableNetConnect` handle everything
// else. Adding a recorded spec touches only that spec file — no config here.
const SNAPSHOTS_DIR = path.resolve(import.meta.dirname, "./test/snapshots");
const fetchMock = createVcrAgent({
  snapshotsDir: SNAPSHOTS_DIR,
  record: RECORD,
  passthroughHosts: [new URL(GATEWAY_ORIGIN).host],
  excludeHeaders: ["x-api-key"],
  ignoreHeaders: ["cookie"]
});

fetchMock.disableNetConnect();
fetchMock
  .get(GATEWAY_ORIGIN)
  .intercept({ path: "/.well-known/jwks.json" })
  .reply(200, gatewayPublicJwks(), {
    headers: { "content-type": "application/json" }
  })
  .persist();

// Every cassette is flushed and its agent closed by the globalSetup teardown
// (test/helpers/vcr-global-setup.ts) — see closeVcr() for why that is required
// to avoid a record-run hang.

// Test defaults for required secrets. Real env vars — from .env.test above, or
// CI/shell — take precedence via ??=. The pool sources `secrets.required`
// (wrangler.jsonc) from process.env into the worker `env`, so a real
// `ARC_API_KEY` in .env.test is all `npm run test:record` needs. In playback
// the placeholder is fine (the VCR excludes the key header from the cassette).
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEWAY_ORIGINS ??= JSON.stringify([GATEWAY_ORIGIN]);
process.env.ARC_API_KEY ??= "test-key";

// The whole suite runs in the Workers runtime (workerd via miniflare) through a
// single `cloudflareTest()` pool — including the agent-runtime specs under
// `test/agent/**`, which drive the decompose/compose operations against an
// injected mock model + a fake `SessionLike`. Error-path tests inject failure by
// throwing synchronously from the model factory (see test/agent/decompose.spec.ts
// and test/subagent/run.spec.ts) rather than passing a model whose `doGenerate`
// rejects into `generateText` — the latter leaks an unhandled rejection through
// the AI SDK telemetry span that workerd flags as a failure.
//
// The pool reads wrangler.jsonc directly (main, compat settings, the AI binding,
// and the ReactiveAgent DO + its SQLite migration) so this config can't drift from
// it; secrets are supplied via process.env above (real env vars take precedence).
//
// `remoteBindings: false` is required, not just the default: Workers AI has no
// local execution mode (Miniflare always proxies `AI` through a remote-connection
// worker), and leaving `remoteBindings` unset — even though `false` is its
// documented default — measurably makes the pool eagerly establish that remote
// connection per test file (~15-20s total, plus a reproducible hang at teardown:
// "close timed out after 10000ms"). Passing `false` explicitly (matching
// looping-gateway's own config) avoids it entirely: `AI.run()` still fails
// gracefully the moment a turn actually calls it, but nothing is attempted at
// test-file startup.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") }
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        fetchMock,
        // Test-only Durable Object binding for the RecipeSubagent facet class.
        // In production it needs NO binding and NO new_sqlite_classes entry —
        // facet storage is created beneath the bound ReactiveAgent — but the
        // Vitest pool only marks bound classes as DO classes, so without this
        // `ctx.exports.RecipeSubagent` is not facet-compatible and `subAgent()`
        // throws (see "Notes for testing" in node_modules/agents/docs/sub-agents.md).
        durableObjects: {
          RECIPE_SUBAGENT: { className: "RecipeSubagent", useSQLite: true }
        }
      }
    })
  ],
  test: {
    globalSetup: ["./test/helpers/vcr-global-setup.ts"],
    include: ["test/**/*.spec.ts"]
  }
});
