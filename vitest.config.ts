import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { MockAgent } from "undici";
import path from "path";
import {
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatewayPublicJwks
} from "./test/fixtures";

// Intercept the gateway's JWKS fetch (triggered by createRemoteJWKSet during
// token verification) so tests never hit the network. disableNetConnect makes
// any unmocked outbound request throw, keeping the suite hermetic.
const fetchMock = new MockAgent();
fetchMock.disableNetConnect();
fetchMock
  .get(GATEWAY_ORIGIN)
  .intercept({ path: "/.well-known/jwks.json" })
  .reply(200, gatewayPublicJwks(), {
    headers: { "content-type": "application/json" }
  })
  .persist();

// Test defaults for required secrets. Real env vars (CI/shell) take precedence via ??=.
process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
process.env.GATEWAY_ORIGINS ??= JSON.stringify([GATEWAY_ORIGIN]);

// The whole suite runs in the Workers runtime (workerd via miniflare) through a
// single `cloudflareTest()` pool — including the agent-runtime specs under
// `test/agent/**`, which drive `runTurn` against an injected mock model + a fake
// `SessionLike`. Error-path tests inject failure by throwing synchronously from
// the model factory (see test/agent/loop.spec.ts) rather than passing a model
// whose `doGenerate` rejects into `generateText` — the latter leaks an unhandled
// rejection through the AI SDK telemetry span that workerd flags as a failure.
//
// The pool reads wrangler.jsonc directly (main, compat settings, the AI binding,
// and the ProactiveAgent DO + its SQLite migration) so this config can't drift from
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
      miniflare: { fetchMock }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"]
  }
});
