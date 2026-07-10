// Generate an Ed25519 private JWK for A2A_SIGNING_KEY. Usage:
//   node scripts/generate-keys.mjs [kid]
import { generateKeyPair, exportJWK } from "jose";

const kid = process.argv[2] ?? `key-${Date.now()}`;

const { privateKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true
});

const priv = await exportJWK(privateKey);
priv.kid = kid;
priv.alg = "EdDSA";

const value = JSON.stringify(priv);

console.log("\n── Local dev (.dev.vars) ───────────────────────────────────");
console.log(`A2A_SIGNING_KEY=${value}`);
console.log("\n── Deployed worker (wrangler secret) ───────────────────────");
console.log(`echo '${value}' | npx wrangler secret put A2A_SIGNING_KEY`);
