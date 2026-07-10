import { importJWK, SignJWT } from "jose";
import {
  TEST_GATEWAY_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "../fixtures";

export interface GatewayTokenOptions {
  audience?: string;
  issuer?: string;
  /** Relative string ("5m"), absolute epoch seconds, or Date. Past values expire the token. */
  expiresIn?: string | number | Date;
  identity?: Record<string, unknown>;
}

/** Sign a short-lived EdDSA gateway JWT using the test gateway key. */
export async function makeGatewayToken(
  options: GatewayTokenOptions = {}
): Promise<string> {
  const privateKey = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
  return new SignJWT({
    "https://looping.ai/identity": options.identity ?? {
      key: "custom:1:test-agent",
      name: "Test Agent",
      kind: "custom",
      workspaceId: 1
    }
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: TEST_GATEWAY_PRIVATE_JWK.kid,
      jku: `${GATEWAY_ORIGIN}/.well-known/jwks.json`
    })
    .setIssuer(options.issuer ?? GATEWAY_ORIGIN)
    .setAudience(options.audience ?? AGENT_ORIGIN)
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}
