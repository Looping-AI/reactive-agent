import { describe, it, expect } from "vitest";
import {
  AgentCard,
  type AgentCardSignature,
  verifyAgentCardSignature
} from "@a2a-js/sdk";
import {
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard,
  A2A_RPC_PATH
} from "@/a2a/card";
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
  it("advertises one JSON-RPC interface at origin + A2A_RPC_PATH", () => {
    // v1.0 replaced the card-level `url`/`preferredTransport`/`protocolVersion`
    // trio with a `supportedInterfaces` list carrying a version per endpoint.
    const card = buildBaseCard(ORIGIN);
    expect(card.supportedInterfaces).toHaveLength(1);
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: `${ORIGIN}${A2A_RPC_PATH}`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0"
    });
  });

  it("disables streaming and advertises push notifications (async accept + notify)", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.capabilities?.streaming).toBe(false);
    expect(card.capabilities?.pushNotifications).toBe(true);
  });

  it("includes required A2A fields", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.name).toBeTruthy();
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it("advertises the gateway bearer-JWT security scheme", () => {
    const card = buildBaseCard(ORIGIN);
    expect(card.securitySchemes.gatewayJwt?.scheme).toEqual({
      $case: "httpAuthSecurityScheme",
      value: { description: "", scheme: "bearer", bearerFormat: "JWT" }
    });
    expect(card.securityRequirements).toEqual([
      { schemes: { gatewayJwt: { list: [] } } }
    ]);
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
  const signatures = (card: Record<string, unknown>): AgentCardSignature[] =>
    card.signatures as AgentCardSignature[];

  it("returns a card with a signatures array", async () => {
    const signed = await signCard(buildBaseCard(ORIGIN), CARD_CFG);
    expect(signatures(signed)).toHaveLength(1);
    expect(signatures(signed)[0]).toHaveProperty("protected");
    expect(signatures(signed)[0]).toHaveProperty("signature");
  });

  it("pins the signing kid and jku in the protected header", async () => {
    const signed = await signCard(buildBaseCard(ORIGIN), CARD_CFG);
    const header = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            signatures(signed)[0]
              .protected.replace(/-/g, "+")
              .replace(/_/g, "/")
          ),
          (c) => c.charCodeAt(0)
        )
      )
    ) as { alg: string; kid: string; jku: string };
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(header.jku).toBe(CARD_CFG.jku);
  });

  it("serves the card in wire form, not the in-memory protobuf shape", async () => {
    // The two differ under v1.0, and only the wire form is valid A2A JSON — the
    // security scheme oneof must be a named key, never a `{ $case, value }` pair.
    const signed = await signCard(buildBaseCard(ORIGIN), CARD_CFG);
    expect(signed.securitySchemes).toEqual({
      gatewayJwt: {
        httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "JWT" }
      }
    });
  });

  it("produces a signature the SDK's own verifier accepts", async () => {
    // The end-to-end guard on what the gateway actually runs at registration.
    // It also pins the ordering `signCard` depends on: the verifier canonicalizes
    // `AgentCard.toJSON(AgentCard.fromJSON(card))`, so signing the in-memory card
    // instead of the wire card would sign different bytes and fail here.
    const signed = await signCard(buildBaseCard(ORIGIN), CARD_CFG);

    const { d: _d, ...pubJwk } = TEST_AGENT_PRIVATE_JWK;
    void _d;

    const verify = verifyAgentCardSignature(async () => pubJwk);
    await expect(
      verify(signed as unknown as AgentCard)
    ).resolves.toBeUndefined();
  });

  it("rejects a tampered card", async () => {
    const signed = await signCard(buildBaseCard(ORIGIN), CARD_CFG);
    const { d: _d, ...pubJwk } = TEST_AGENT_PRIVATE_JWK;
    void _d;

    const tampered = { ...signed, name: "Impostor Agent" };
    const verify = verifyAgentCardSignature(async () => pubJwk);
    await expect(verify(tampered as unknown as AgentCard)).rejects.toThrow();
  });
});
