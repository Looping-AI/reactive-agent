import type { JWK } from "jose";
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  generateAgentCardSignature
} from "@a2a-js/sdk";
import { manifest } from "@/reactive-agent/manifest";

/** JWS algorithm for the card signature — must match the gateway (`EdDSA`). */
const ALG = "EdDSA";

/** The JSON-RPC path this agent answers on (the card's interface `url`). */
export const A2A_RPC_PATH = "/a2a";

export interface CardSigningConfig {
  /** Ed25519 private JWK (with `kid`) that signs the card. */
  privateJwk: JWK & { kid: string };
  /** Public URL serving this agent's JWKS — embedded as the JWS `jku`. */
  jku: string;
}

/**
 * The AgentCard in its **wire** (JSON) form, as served at the card path.
 *
 * A2A v1.0 types are protobuf-generated, so the in-memory `AgentCard` and its
 * JSON encoding are different shapes: oneofs are `{ $case, value }` in memory but
 * a single named key on the wire, and empty/default fields are dropped. Signing
 * and serving both operate on the wire form (see {@link signCard}), so it gets
 * its own type rather than being conflated with `AgentCard`.
 */
export type WireAgentCard = Record<string, unknown>;

/**
 * Build the (unsigned) AgentCard. `supportedInterfaces` replaces v0.3's
 * `url`/`preferredTransport`/card-level `protocolVersion`: one entry per
 * endpoint, each carrying the protocol version it speaks. We expose a single
 * JSON-RPC interface at this worker's own origin.
 *
 * The card advertises the gateway's auth scheme (HTTP Bearer JWT) so the
 * contract is self-describing. `streaming:false` (we don't stream);
 * `pushNotifications:true` — replies are delivered asynchronously to the gateway
 * webhook (see the manifest and `src/a2a/notify.ts`).
 */
export function buildBaseCard(origin: string): AgentCard {
  return {
    ...manifest,
    supportedInterfaces: [
      {
        url: `${origin}${A2A_RPC_PATH}`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        // Single-tenant agent: one DO per verified gateway identity, so the
        // protocol-level tenant slot goes unused.
        tenant: ""
      }
    ],
    provider: undefined,
    // The gateway authenticates every call with a short-lived EdDSA JWT sent as
    // an HTTP Bearer token; advertise that so the card is self-documenting.
    securitySchemes: {
      gatewayJwt: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "", scheme: "bearer", bearerFormat: "JWT" }
        }
      }
    },
    // v0.3's `security: [{ gatewayJwt: [] }]`. The empty `list` means the scheme
    // is required but carries no scopes.
    securityRequirements: [{ schemes: { gatewayJwt: { list: [] } } }],
    signatures: []
  };
}

/**
 * Sign the card with a detached-payload EdDSA flattened JWS over its canonical
 * JSON, and return the signed **wire** card. The gateway strips the `signatures`
 * array, recomputes the canonical payload, and verifies — pinning this key's
 * `kid`+`jku` on first registration (Trust-On-First-Use).
 *
 * Canonicalization is the SDK's `canonicalizeAgentCard` (JCS / RFC 8785),
 * reached through `generateAgentCardSignature`; we no longer hand-roll it, so
 * this side cannot drift from the gateway's `verifyAgentCardSignature`.
 *
 * The card is converted with `AgentCard.toJSON` **before** signing, and that
 * ordering is load-bearing: the SDK's verifier normalizes the card it receives
 * through `AgentCard.toJSON(AgentCard.fromJSON(card))` before canonicalizing, so
 * a signature computed over the in-memory (protobuf-shaped) card covers
 * different bytes than the verifier checks and fails every time. Signing the
 * wire form makes both sides canonicalize the identical object.
 */
export async function signCard(
  card: AgentCard,
  cfg: CardSigningConfig
): Promise<WireAgentCard> {
  const sign = generateAgentCardSignature(cfg.privateJwk, {
    alg: ALG,
    kid: cfg.privateJwk.kid,
    jku: cfg.jku,
    typ: "JOSE"
  });
  // `AgentCardSignatureGenerator` is typed in terms of the in-memory `AgentCard`,
  // but it canonicalizes whatever object it is handed — the wire card, per above.
  const signed = await sign(AgentCard.toJSON(card) as AgentCard);
  return signed as unknown as WireAgentCard;
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
