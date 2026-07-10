import { FlattenedSign, importJWK, type JWK } from "jose";
import type { AgentCard } from "@a2a-js/sdk";
import { canonicalCardPayload } from "./canonical";
import { manifest } from "@/proactive-agent/manifest";

/** JWS algorithm for the card signature — must match the gateway (`EdDSA`). */
const ALG = "EdDSA";

/** The JSON-RPC path this agent answers on (the card's `url`). */
export const A2A_RPC_PATH = "/a2a";

/** An AgentCard plus the spec fields used for signing + auth advertisement. */
type SignedAgentCard = AgentCard & {
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  signatures?: Array<{ protected: string; signature: string }>;
};

export interface CardSigningConfig {
  /** Ed25519 private JWK (with `kid`) that signs the card. */
  privateJwk: JWK & { kid: string };
  /** Public URL serving this agent's JWKS — embedded as the JWS `jku`. */
  jku: string;
}

/**
 * Build the (unsigned) AgentCard. `url` is the JSON-RPC endpoint the gateway
 * will POST to; it must be reachable at this worker's own origin. The card
 * advertises the gateway's auth scheme (HTTP Bearer JWT) so the contract is
 * self-describing. `streaming:false` (we don't stream); `pushNotifications:true`
 * — replies are delivered asynchronously to the gateway webhook (see the manifest
 * and `src/a2a/notify.ts`).
 */
export function buildBaseCard(origin: string): SignedAgentCard {
  return {
    ...manifest,
    protocolVersion: "0.3.0",
    url: `${origin}${A2A_RPC_PATH}`,
    preferredTransport: "JSONRPC",
    // The gateway authenticates every call with a short-lived EdDSA JWT sent as
    // an HTTP Bearer token; advertise that so the card is self-documenting.
    securitySchemes: {
      gatewayJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
    },
    security: [{ gatewayJwt: [] }]
  };
}

/**
 * Sign the card with a detached-payload EdDSA flattened JWS over its canonical
 * JSON (see `canonical.ts`). The signed card carries the signature(s) in a
 * `signatures` array (A2A spec §8.4); the gateway strips that array, recomputes
 * the canonical payload, and verifies — pinning this key's `kid`+`jku` on first
 * registration (Trust-On-First-Use).
 */
export async function signCard(
  card: SignedAgentCard,
  cfg: CardSigningConfig
): Promise<SignedAgentCard> {
  const key = await importJWK(cfg.privateJwk, ALG);
  const payload = new TextEncoder().encode(
    canonicalCardPayload(card as unknown as Record<string, unknown>)
  );
  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: ALG, kid: cfg.privateJwk.kid, jku: cfg.jku })
    .sign(key);
  return {
    ...card,
    signatures: [{ protected: jws.protected ?? "", signature: jws.signature }]
  };
}

/**
 * Parse and validate the `A2A_SIGNING_KEY` env var into the private JWK used to
 * sign the card. Throws if the JWK is missing its `kid` (required for the JWS
 * protected header and gateway key-pinning).
 */
export function parsePrivateJwk(raw: string): CardSigningConfig["privateJwk"] {
  const jwk = JSON.parse(raw) as { kid?: string };
  if (!jwk.kid) throw new Error("A2A_SIGNING_KEY must include a `kid`");
  return jwk as CardSigningConfig["privateJwk"];
}

/** Public card-signing JWKS (served at the `jku`): the private JWK minus `d`. */
export function publicCardJwks(privateJwk: JWK & { kid: string }): {
  keys: JWK[];
} {
  const { d: _d, ...pub } = privateJwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: ALG }] };
}
