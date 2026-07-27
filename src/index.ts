import {
  AGENT_CARD_PATH,
  A2A_VERSION_HEADER,
  type TaskPushNotificationConfig
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  type User
} from "@a2a-js/sdk/server";
import { RequestMalformedError, toJsonRpcError } from "@a2a-js/sdk/errors";
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
export { RecipeSubagent } from "./subagent";
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

/**
 * The verified calling gateway, as the SDK's {@link User}. A2A v1.0 made
 * `ServerCallContext` mandatory across the server interfaces, and stores use
 * `context.user` to scope data to its owner. Our scoping is one level up — the
 * DO instance is already keyed by `identity.key` — so this exists to keep the
 * context honest about who the authenticated caller is rather than to drive
 * lookups.
 */
class GatewayUser implements User {
  constructor(private readonly identity: GatewayIdentity) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.identity.key ?? "";
  }
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

      const body = (await request.json()) as Record<string, unknown>;
      const rpcBody = body as {
        id?: string | number | null;
        method?: string;
        params?: {
          configuration?: {
            taskPushNotificationConfig?: TaskPushNotificationConfig;
          };
        };
      };

      // This agent is async-only: a `SendMessage` must carry a push-notification
      // config (webhook + token) so the reply can be delivered out of band.
      // Reject a synchronous send up front — there is nowhere to notify
      // otherwise. (`GetTask`/`CancelTask` and discovery carry no config.)
      //
      // v1.0 renamed both the method (`message/send` → `SendMessage`) and the
      // field (`configuration.pushNotificationConfig` →
      // `configuration.taskPushNotificationConfig`), and flattened `url`/`token`
      // onto that object.
      const pushConfig =
        rpcBody.params?.configuration?.taskPushNotificationConfig;
      if (rpcBody.method === "SendMessage") {
        let pushConfigError: string | undefined;
        if (!pushConfig?.url) {
          pushConfigError =
            "taskPushNotificationConfig.url is required: this agent " +
            "replies asynchronously via push notification (A2A §13.2)";
        } else if (!pushConfig.token) {
          pushConfigError =
            "taskPushNotificationConfig.token is required: the gateway uses it " +
            "to correlate the callback to the pending task (A2A §13.2)";
        } else {
          try {
            new URL(pushConfig.url);
          } catch {
            pushConfigError = `taskPushNotificationConfig.url is not a valid URL: ${pushConfig.url}`;
          }
        }
        if (pushConfigError) {
          // Map through the SDK so the JSON-RPC code and its `data` payload stay
          // tied to the spec's error registry instead of a hard-coded -32602.
          return Response.json({
            jsonrpc: "2.0",
            id: rpcBody.id ?? null,
            error: toJsonRpcError(new RequestMalformedError(pushConfigError))
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
      // `ServerCallContext` is mandatory in v1.0. `requestedVersion` comes from
      // the `A2A-Version` header and is validated against the versions our card
      // declares on its JSON-RPC interface; leaving it unset makes the SDK assume
      // v0.3, which this card no longer advertises. Passing `undefined` when the
      // header is absent keeps that SDK default (and its clean
      // `VersionNotSupportedError`) rather than silently promoting the caller.
      const result = await rpc.handle(
        body,
        new ServerCallContext({
          user: new GatewayUser(identity),
          requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined
        })
      );

      // We don't advertise streaming; reject async generators outright.
      if (Symbol.asyncIterator in (result as object)) {
        return new Response("streaming not supported", { status: 501 });
      }
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
