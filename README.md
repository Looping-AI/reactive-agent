# Looping AI Reactive Agent

A complete, deployable **reference custom agent** for
[looping-gateway](https://github.com/Looping-AI/looping-gateway). It shows
exactly what a third party must implement to be safely registered and routed to
by the gateway — using **zero shared secrets**. All trust flows through
asymmetric Ed25519 signatures over public JWKS.

Replies are **asynchronous** (A2A push notifications): the agent accepts a turn
immediately with a `submitted` task and delivers the answer later by POSTing the
completed task to the gateway's `/a2a/notifications` webhook, authenticated with a
callback JWT signed by the same card key. Generation + delivery run in a durable
Cloudflare Workflow. See [ARCHITECTURE.md](ARCHITECTURE.md) → _Async task delivery_.

## Getting Started

### 1. Install dependencies

```sh
npm install
```

### 2. Generate the local A2A signing key

```sh
cp .dev.vars.example .dev.vars
npm run keygen example-1
```

Copy the printed private JWK into `.dev.vars` as `A2A_SIGNING_KEY`.

### 3. Configure the gateway origin

In `.dev.vars`, point `GATEWAY_ORIGINS` at your deployed gateway:

```sh
GATEWAY_ORIGINS=["https://<your-gateway>"]
```

This must match the gateway's own `GATEWAY_ORIGIN`. Add multiple entries for multi-worker setups or domain transitions.

### 4. Run locally

```sh
npm run dev
```

The gateway is deployed to production, so it needs a publicly reachable URL to call back into your local machine. You need a tunnel.

**Option A — Built-in tunnel (quickest)**

Once the dev server is running, press **`t`** in the terminal. Wrangler starts a temporary `trycloudflare.com` URL and prints it:

```
⬣ Sharing via Cloudflare Tunnel: https://video-spots-novels-supplemental.trycloudflare.com/
```

Use that URL when registering the agent on the gateway (step 6). The limitation is that the URL is random and changes every tunnel session — you'll need to re-register the agent each time.

**Option B — Named tunnel with a fixed URL (long-term development)**

Requires a domain managed by Cloudflare (free tier works). One-time setup:

```sh
npx wrangler tunnel create reactive-agent-dev
npx wrangler tunnel route dns reactive-agent-dev <your-subdomain.yourdomain.com>
```

Then start your dev server with the tunnel in one command:

```sh
npx wrangler dev --tunnel --tunnel-name reactive-agent-dev
```

Register the agent once at `https://<your-subdomain.yourdomain.com>` and the URL stays valid across restarts.

### 5. Deploy to production

For the first deployment, the Worker does not yet exist, so Wrangler cannot set
its secrets in advance. Create an ignored deployment secrets file from the
example, then generate a production signing key:

```sh
cp .dev.vars.example secrets
npm run keygen agent-1
```

`agent-1` is an example key identifier (`kid`), not a required name. Replace it
with any descriptive identifier you choose for this agent's signing key.

Set `A2A_SIGNING_KEY` in `secrets` to the private JWK printed by `keygen`, and
set `GATEWAY_ORIGINS` to the deployed gateway origin:

```sh
A2A_SIGNING_KEY=<private JWK printed by keygen>
GATEWAY_ORIGINS=["https://<your-gateway>"]
```

Deploy the new Worker with both secrets:

```sh
npx wrangler deploy --secrets-file secrets
```

After this first deployment, don't forget to delete `secrets` file.
In future, rotate either secret with `npx wrangler secret put
<SECRET_NAME>` and deploy normally with `npx wrangler deploy`. Never commit the
`secrets` file.

SQLite schema migrations run automatically inside each Durable Object instance on first wake-up — no separate migration command is needed.

You can observe the deployment (stats and logs) on your Cloudflare dashboard.

## Register it on the gateway

In a workspace admin channel, ask the admin agent to register this agent with
its **HTTPS** endpoint (the deployed worker origin). Registration fails unless:

- the endpoint is HTTPS and passes the gateway's SSRF policy,
- the AgentCard is reachable and **validly signed**,
- the signing key resolves from the card's `jku`.

Attach it to channels, then mention it with its `::name` reference.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full trust model, sequence diagrams, canonical JSON spec, environment variables, and file map.

## Feedback

Found a bug or have a question? [Open an issue](https://github.com/Looping-AI/reactive-agent/issues) — bug reports, questions, and improvement ideas are all welcome.

## Contributing

1. Fork the repo and create a feature branch.
2. Make your changes — keep the scope focused.
3. Open a pull request with a clear description of what and why.

Please check [ARCHITECTURE.md](ARCHITECTURE.md) before contributing.

## License

[GPL-3.0](LICENSE)
