import { describe, it, expect } from "vitest";
import { importJWK, flattenedVerify, base64url } from "jose";
import {
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard,
  A2A_RPC_PATH
} from "@/a2a/card";
import { canonicalCardPayload } from "@/a2a/canonical";
import { TEST_AGENT_PRIVATE_JWK } from "../fixtures";

const ORIGIN = "https://agent.example.com";

const CARD_CFG = {
  privateJwk: TEST_AGENT_PRIVATE_JWK,
  jku: `${ORIGIN}/.well-known/jwks.json`
};

describe("parsePrivateJwk", () => {
  it("returns the parsed JWK when kid is present", () => {
    const jwk = { ...TEST_AGENT_PRIVATE_JWK };
    const raw = JSON.stringify(jwk);
    const result = parsePrivateJwk(raw);
    expect(result.kid).toBe(jwk.kid);
    expect(result.kty).toBe(jwk.kty);
  });

  it("throws when kid is missing", () => {
    const { kid: _kid, ...jwkWithoutKid } = TEST_AGENT_PRIVATE_JWK;
    void _kid;
    const raw = JSON.stringify(jwkWithoutKid);
    expect(() => parsePrivateJwk(raw)).toThrow(
      "A2A_SIGNING_KEY must include a `kid`"
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePrivateJwk("not-json")).toThrow();
  });
});

describe("buildBaseCard", () => {
  it("sets url to origin + A2A_RPC_PATH", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.url).toBe(`${ORIGIN}${A2A_RPC_PATH}`);
  });

  it("disables streaming and advertises push notifications (async accept + notify)", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.capabilities?.streaming).toBe(false);
    expect(card.capabilities?.pushNotifications).toBe(true);
  });

  it("includes required A2A fields", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.name).toBeTruthy();
    expect(card.protocolVersion).toBeTruthy();
    expect(card.skills.length).toBeGreaterThan(0);
  });
});

describe("publicCardJwks", () => {
  it("strips the private key parameter d", () => {
    const jwks = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("preserves kid, kty, crv, and x", () => {
    const jwks = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    const key = jwks.keys[0];
    expect(key.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(key.kty).toBe("OKP");
    expect(key.crv).toBe("Ed25519");
    expect(key.x).toBe(TEST_AGENT_PRIVATE_JWK.x);
  });

  it("adds use sig and alg EdDSA", () => {
    const jwks = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    const key = jwks.keys[0];
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("EdDSA");
  });
});

describe("signCard", () => {
  it("returns a card with a signatures array", async () => {
    const card = buildBaseCard(ORIGIN);
    const signed = await signCard(card, CARD_CFG);
    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures![0]).toHaveProperty("protected");
    expect(signed.signatures![0]).toHaveProperty("signature");
  });

  it("signature verifies against the canonical card payload", async () => {
    const card = buildBaseCard(ORIGIN);
    const signed = await signCard(card, CARD_CFG);

    const { d: _d, ...pubJwk } = TEST_AGENT_PRIVATE_JWK;
    const publicKey = await importJWK(pubJwk, "EdDSA");

    const sig = signed.signatures![0];
    // The card stores protected + signature only (no embedded payload).
    // Reconstruct the full flattened JWS by base64url-encoding the canonical
    // payload so flattenedVerify can check the signature end-to-end.
    const payloadBytes = new TextEncoder().encode(
      canonicalCardPayload(card as unknown as Record<string, unknown>)
    );
    await expect(
      flattenedVerify(
        {
          protected: sig.protected,
          payload: base64url.encode(payloadBytes),
          signature: sig.signature
        },
        publicKey,
        { algorithms: ["EdDSA"] }
      )
    ).resolves.toBeDefined();
  });
});
