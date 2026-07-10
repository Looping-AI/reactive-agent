import { type JWK } from "jose";

/** The gateway origin used in all tests. Must match vitest.config.ts and the MockAgent setup. */
export const GATEWAY_ORIGIN = "https://gateway.test";

/** Agent origin matching `url.origin` for requests to `http://localhost`. */
export const AGENT_ORIGIN = "http://localhost";

/** Fixed Ed25519 private JWK used as A2A_SIGNING_KEY in tests. */
export const TEST_AGENT_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "sbR9EgZV1zUY-K6ENkvSLY8c8Q9kJ9NnxsXc4GVx_1g",
  x: "1dXrUHeE89GBnZbd7MjzJK-3Xvu7khZCK9ZrQauZQ6s",
  kty: "OKP",
  kid: "test-agent-key-1"
};

/** Fixed Ed25519 private JWK for signing gateway JWTs in tests. */
export const TEST_GATEWAY_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "OVKcn3LDH-qybNIdUbr7T9wbmlxNk2maU4_nILbaLKY",
  x: "jYiAbquXL6db7RihLvp2nsp1ShAolDI0tGOjuwsZVnI",
  kty: "OKP",
  kid: "test-gw-key-1"
};

/** Public JWKS the gateway would serve at its `jku` (the private key minus `d`). */
export function gatewayPublicJwks(): string {
  const { d: _d, ...pub } = TEST_GATEWAY_PRIVATE_JWK;
  return JSON.stringify({ keys: [{ ...pub, use: "sig", alg: "EdDSA" }] });
}
