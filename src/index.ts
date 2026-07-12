import { AGENT_CARD_PATH, type PushNotificationConfig } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler
} from "@a2a-js/sdk/server";
import {
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard
} from "./a2a/card";
import {
  GatewayAuthError,
  bearerToken,
  verifyGatewayToken,
  type GatewayIdentity
} from "./a2a/verify";
import { A2AExecutor } from "./a2a/executor";
import { DurableTaskStore } from "./a2a/task-store";

export { ReactiveAgent } from "./reactive-agent";
export { HandleTaskWorkflow } from "./workflows/handle-task";

/**
 * Reference remote and reactive A2A agent for looping-gateway.
 *
 * The outer Worker owns the zero-trust, no-shared-secrets contract and runs the
 * one A2A JSON-RPC server, dispatching each verified call into the agent
 * Durable Object:
 *
 *  1. Publish the card-signing **public** JWKS at the card's `jku`.
 *  2. Serve a **signed** AgentCard at `…/.well-known/agent-card.json` so the
 *     gateway can verify+pin the agent's identity at registration ("G knows R").
 *  3. **Verify the gateway's identity JWT** on every JSON-RPC call against the
 *     gateway's public JWKS ("R knows G"), then run the A2A JSON-RPC server for
 *     this call. The {@link A2AExecutor} dispatches into the caller's
 *     {@link file://./reactive-agent/index.ts ReactiveAgent} DO — one instance per
 *     calling gateway-agent (keyed by the verified `identity.key`) — with a
 *     single native Cloudflare RPC call (no internal wire protocol); the DO
 *     holds that caller's durable Session and answers via the Workers-AI loop.
 *
 * No secret is ever shared between the gateway and this agent — trust flows
 * entirely on the domains and through asymmetric (Ed25519) signatures over public JWKS.
 */

/** Path serving this agent's card-signing public JWKS (the card's `jku`). */
const JWKS_PATH = "/.well-known/jwks.json";

function unauthorized(reason: string): Response {
  return new Response(`unauthorized: ${reason}`, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const privateJwk = parsePrivateJwk(env.A2A_SIGNING_KEY);

    // (1) Card-signing public JWKS — resolves the card's `jku` for the gateway.
    if (request.method === "GET" && url.pathname === JWKS_PATH) {
      return Response.json(publicCardJwks(privateJwk), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // (2) Signed AgentCard discovery.
    if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
      const card = await signCard(buildBaseCard(origin), {
        privateJwk,
        jku: `${origin}${JWKS_PATH}`
      });
      return Response.json(card);
    }

    // (3) A2A JSON-RPC — gateway-authenticated, dispatched into the caller's DO.
    if (request.method === "POST") {
      const token = bearerToken(request);
      if (!token) return unauthorized("missing gateway bearer token");

      let identity: GatewayIdentity;
      try {
        ({ identity } = await verifyGatewayToken(token, {
          allowedOrigins: JSON.parse(env.GATEWAY_ORIGINS) as string[],
          audience: origin
        }));
      } catch (err) {
        const message =
          err instanceof GatewayAuthError ? err.message : "verification failed";
        return unauthorized(message);
      }

      // The DO instance is keyed by the verified `identity.key`; without it the
      // executor cannot route the call — refuse rather than fall back to a
      // shared instance. Guaranteed non-null past this point.
      if (!identity.key) {
        return new Response("bad request: gateway identity missing key", {
          status: 400
        });
      }

      const body = await request.json();
      const rpcBody = body as {
        id?: string | number | null;
        method?: string;
        params?: {
          configuration?: { pushNotificationConfig?: PushNotificationConfig };
        };
      };

      // This agent is async-only: a `message/send` must carry a
      // `pushNotificationConfig` (webhook + token) so the reply can be delivered
      // out of band. Reject a synchronous send up front — there is nowhere to
      // notify otherwise. (`tasks/*` and discovery methods carry no config.)
      const pushConfig = rpcBody.params?.configuration?.pushNotificationConfig;
      if (rpcBody.method === "message/send") {
        let pushConfigError: string | undefined;
        if (!pushConfig?.url) {
          pushConfigError =
            "pushNotificationConfig.url is required: this agent " +
            "replies asynchronously via push notification (A2A §13.2)";
        } else if (!pushConfig.token) {
          pushConfigError =
            "pushNotificationConfig.token is required: the gateway uses it " +
            "to correlate the callback to the pending task (A2A §13.2)";
        } else {
          try {
            new URL(pushConfig.url);
          } catch {
            pushConfigError = `pushNotificationConfig.url is not a valid URL: ${pushConfig.url}`;
          }
        }
        if (pushConfigError) {
          return Response.json({
            jsonrpc: "2.0",
            id: rpcBody.id ?? null,
            error: { code: -32602, message: pushConfigError }
          });
        }
      }

      const handler = new DefaultRequestHandler(
        buildBaseCard(origin),
        new DurableTaskStore(identity),
        new A2AExecutor(identity, {
          pushConfig,
          jku: `${origin}${JWKS_PATH}`
        })
      );
      const rpc = new JsonRpcTransportHandler(handler);
      const result = await rpc.handle(body);

      // We don't advertise streaming; reject async generators outright.
      if (Symbol.asyncIterator in (result as object)) {
        return new Response("streaming not supported", { status: 501 });
      }
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
