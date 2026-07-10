import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload
} from "jose";

/**
 * Verify the gateway identity JWT (the "B authenticates A" half of zero-trust).
 *
 * The gateway signs a short-lived EdDSA JWT and sends it as a Bearer token on
 * every A2A call. Per RFC 7515 §4.1.2 it embeds a `jku` header pointing at its
 * public JWKS, so remote agents don't need a separately configured JWKS URL —
 * they read `jku` straight from the token and verify the key from there.
 *
 * Security: the `jku` origin is validated against `GATEWAY_ORIGINS` before
 * fetching, preventing key-injection attacks (an attacker cannot point `jku` at
 * their own JWKS and have it accepted).
 */

/** Algorithm the gateway signs with — reject anything else. */
const ALG = "EdDSA";

/** Namespaced claim the gateway uses for the minimal caller identity. */
export const IDENTITY_CLAIM = "https://looping.ai/identity";

/**
 * The gateway-agent instance identity forwarded by the gateway — i.e. which
 * registered custom-agent instance dispatched this call, not the Slack end
 * user. Mirrors `RemoteIdentity` in looping-gateway's `src/auth/agent-jwt.ts`.
 * The Slack user (if any) travels unverified, inline in the `<turn>` tag in
 * the message text — the gateway deliberately excludes it from this signed
 * claim so a remote agent can't read the full caller auth context.
 */
export interface GatewayIdentity {
  /** Canonical instance key, e.g. `custom:7:analytics`. */
  key?: string;
  /** Registry name of the logical agent instance. */
  name?: string;
  /** Dispatch kind of the caller (today always `"custom"` for remote agents). */
  kind?: string;
  /** Workspace the calling agent instance belongs to. */
  workspaceId?: number | null;
}

/** Thrown when a gateway token is missing or fails verification. */
export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

// jose's remote JWKS helper caches keys + handles rotation; build one per URL
// and reuse it across requests in the same isolate.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, set);
  }
  return set;
}

/** Extract the Bearer token from an `Authorization` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export interface VerifyOptions {
  /** Allowed gateway origins — validates both the `jku` domain and `iss` claim. */
  allowedOrigins: string[];
  audience: string;
}

/**
 * Verify a gateway JWT and return its payload + parsed identity.
 *
 * The `jku` JWK Set URL is read directly from the token's protected header
 * (RFC 7515 §4.1.2) and validated against `issuer` before fetching, so no
 * separate JWKS URL configuration is needed on the remote side.
 *
 * Throws {@link GatewayAuthError} on any failure.
 */
export async function verifyGatewayToken(
  token: string,
  opts: VerifyOptions
): Promise<{ payload: JWTPayload; identity: GatewayIdentity }> {
  try {
    // Extract jku from the protected header — this is the standard way the
    // gateway advertises where to fetch its public key (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as { jku?: string };
    const jku = header.jku;
    if (!jku) {
      throw new GatewayAuthError(
        "gateway JWT missing jku header (RFC 7515 §4.1.2)"
      );
    }
    // Security: validate the jku origin before fetching. Without this an
    // attacker could forge a token with jku pointing at their own JWKS.
    const jkuOrigin = new URL(jku).origin;
    if (!opts.allowedOrigins.includes(jkuOrigin)) {
      throw new GatewayAuthError(
        `jku origin '${jkuOrigin}' is not in the allowed gateway origins`
      );
    }
    // Prevent one listed gateway from impersonating another: the origin where
    // keys are fetched must match the origin that issued the token.
    const rawIss = decodeJwt(token).iss ?? "";
    const issOrigin = new URL(rawIss).origin;
    if (issOrigin !== jkuOrigin) {
      throw new GatewayAuthError(
        `jku origin '${jkuOrigin}' does not match iss origin '${issOrigin}'`
      );
    }
    const { payload } = await jwtVerify(token, jwksFor(jku), {
      issuer: opts.allowedOrigins,
      audience: opts.audience,
      algorithms: [ALG]
    });
    const identity =
      (payload[IDENTITY_CLAIM] as GatewayIdentity | undefined) ?? {};
    return { payload, identity };
  } catch (err) {
    if (err instanceof GatewayAuthError) throw err;
    throw new GatewayAuthError((err as Error).message);
  }
}
