/**
 * Test-only Env augmentation. The `RECIPE_SUBAGENT` Durable Object binding is
 * added by the miniflare override in vitest.config.ts — the Vitest pool only
 * treats *bound* classes as facet-compatible, so the binding lets tests both
 * create `RecipeSubagent` facets beneath the parent and drive the class
 * directly via `runInDurableObject`. It is NOT part of the production Env
 * (facets need no binding in production); this file is picked up only by
 * test/tsconfig.json.
 */
declare namespace Cloudflare {
  interface Env {
    // Optional so the generated production `Env` (which legitimately lacks the
    // binding) stays assignable to `Cloudflare.Env`; tests guard at runtime.
    RECIPE_SUBAGENT?: DurableObjectNamespace<
      import("../src/subagent").RecipeSubagent
    >;
  }
}
