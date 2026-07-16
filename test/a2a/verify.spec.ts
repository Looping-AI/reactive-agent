import { describe, it, expect } from "vitest";
import { SignJWT, importJWK } from "jose";
import {
  bearerToken,
  GatewayAuthError,
  normalizeGatewayOrigins,
  verifyGatewayToken,
  IDENTITY_CLAIM
} from "@/a2a/verify";
import {
  GATEWAY_ORIGIN,
  AGENT_ORIGIN,
  TEST_GATEWAY_PRIVATE_JWK,
  TEST_AGENT_PRIVATE_JWK
} from "../fixtures";
import { makeGatewayToken } from "../helpers/auth";

// --- bearerToken ---

describe("bearerToken", () => {
  function req(authorization?: string) {
    return new Request("https://example.com", {
      headers: authorization ? { authorization } : {}
    });
  }

  it("extracts token from a well-formed Bearer header", () => {
    expect(bearerToken(req("Bearer abc123"))).toBe("abc123");
  });

  it("is case-insensitive for the scheme prefix", () => {
    expect(bearerToken(req("bearer mytoken"))).toBe("mytoken");
    expect(bearerToken(req("BEARER mytoken"))).toBe("mytoken");
  });

  it("returns null when the authorization header is missing", () => {
    expect(bearerToken(req())).toBeNull();
  });

  it("returns null for a non-Bearer scheme", () => {
    expect(bearerToken(req("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null for a bare scheme with no token", () => {
    expect(bearerToken(req("Bearer"))).toBeNull();
    expect(bearerToken(req("Bearer "))).toBeNull();
  });
});

// --- GatewayAuthError ---

describe("GatewayAuthError", () => {
  it("is an instance of Error", () => {
    expect(new GatewayAuthError("oops")).toBeInstanceOf(Error);
  });

  it("has name GatewayAuthError", () => {
    expect(new GatewayAuthError("oops").name).toBe("GatewayAuthError");
  });

  it("preserves the message", () => {
    expect(new GatewayAuthError("bad token").message).toBe("bad token");
  });
});

// --- verifyGatewayToken ---

const OPTS = {
  allowedOrigins: [GATEWAY_ORIGIN],
  audience: AGENT_ORIGIN
};

describe("normalizeGatewayOrigins", () => {
  it("canonicalizes trailing slashes and insecure or omitted schemes to HTTPS", () => {
    expect(
      normalizeGatewayOrigins([
        "https://gateway.test/",
        "http://gateway.test",
        "gateway.test"
      ])
    ).toEqual([GATEWAY_ORIGIN, GATEWAY_ORIGIN, GATEWAY_ORIGIN]);
  });

  it("lets verifyGatewayToken accept hostname/http variants in allowedOrigins", async () => {
    const token = await makeGatewayToken();

    await expect(
      verifyGatewayToken(token, { ...OPTS, allowedOrigins: ["gateway.test"] })
    ).resolves.toBeTruthy();

    await expect(
      verifyGatewayToken(token, {
        ...OPTS,
        allowedOrigins: ["http://gateway.test/"]
      })
    ).resolves.toBeTruthy();
  });

  it("rejects empty or invalid configured origins", () => {
    expect(() => normalizeGatewayOrigins([" "])).toThrow(GatewayAuthError);
    expect(() => normalizeGatewayOrigins(["http://"])).toThrow(
      GatewayAuthError
    );
  });
});

describe("verifyGatewayToken — error paths", () => {
  it("throws GatewayAuthError for a JWT without jku header", async () => {
    // Build a token that has no jku in its protected header
    const key = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(key);

    await expect(verifyGatewayToken(token, OPTS)).rejects.toBeInstanceOf(
      GatewayAuthError
    );
  });

  it("throws GatewayAuthError when jku origin is not in allowedOrigins", async () => {
    const key = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({})
      .setProtectedHeader({
        alg: "EdDSA",
        jku: "https://evil.attacker.com/.well-known/jwks.json"
      })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(key);

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: [GATEWAY_ORIGIN],
        audience: AGENT_ORIGIN
      })
    ).rejects.toBeInstanceOf(GatewayAuthError);
  });

  it("rejects an expired token", async () => {
    const token = await makeGatewayToken({
      expiresIn: Math.floor(Date.now() / 1000) - 60
    });
    await expect(verifyGatewayToken(token, OPTS)).rejects.toBeInstanceOf(
      GatewayAuthError
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await makeGatewayToken({
      audience: "https://someone-else.example.com"
    });
    await expect(verifyGatewayToken(token, OPTS)).rejects.toBeInstanceOf(
      GatewayAuthError
    );
  });

  it("rejects a token whose jku origin differs from its iss origin", async () => {
    // Both origins are in allowedOrigins — this tests the cross-check, not the
    // allowlist check. GatewayB's JWKS is never fetched because the check fires
    // before the network call.
    const GATEWAY_B_ORIGIN = "https://gateway-b.test";
    const key = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({})
      .setProtectedHeader({
        alg: "EdDSA",
        jku: `${GATEWAY_B_ORIGIN}/.well-known/jwks.json`
      })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(key);

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: [GATEWAY_ORIGIN, GATEWAY_B_ORIGIN],
        audience: AGENT_ORIGIN
      })
    ).rejects.toBeInstanceOf(GatewayAuthError);
  });

  it("rejects a token signed by a key not in the gateway JWKS", async () => {
    // jku still points at the trusted gateway origin (passes the origin check),
    // but the token is signed with the agent key — the signature must fail
    // against the gateway's published public key.
    const wrongKey = await importJWK(TEST_AGENT_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({})
      .setProtectedHeader({
        alg: "EdDSA",
        jku: `${GATEWAY_ORIGIN}/.well-known/jwks.json`
      })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(wrongKey);

    await expect(verifyGatewayToken(token, OPTS)).rejects.toBeInstanceOf(
      GatewayAuthError
    );
  });
});

describe("verifyGatewayToken — happy path", () => {
  it("returns payload and identity for a valid token", async () => {
    const identity = {
      key: "custom:7:analytics",
      name: "analytics",
      kind: "custom",
      workspaceId: 7
    };
    const token = await makeGatewayToken({ identity });

    const result = await verifyGatewayToken(token, OPTS);

    expect(result.identity.key).toBe("custom:7:analytics");
    expect(result.identity.name).toBe("analytics");
    expect(result.identity.workspaceId).toBe(7);
    expect(result.payload[IDENTITY_CLAIM]).toEqual(identity);
  });
});
