// Cloudflare API proxy. Reads credentials from .env.local so the token never
// appears in the terminal, in shell history, or in an agent's context — the
// script holds it in memory, prints only the API response, and redacts the
// token from any output as a safety net.
//
// Usage:
//   node scripts/cf.mjs verify                       → GET /accounts/{id}/tokens/verify
//   node scripts/cf.mjs [METHOD] <path> [flags]
//
// Flags:
//   -d, --data <json|@file>   request body (raw JSON string, or @path to a file)
//   -q, --query <k=v>         append a query param (repeatable)
//       --raw                 print response body verbatim (no JSON pretty-print)
//
// Path rules:
//   starts with "/"  → used verbatim under https://api.cloudflare.com/client/v4
//   otherwise        → account-relative: /accounts/{ACCOUNT_ID}/<path>
//
// Examples:
//   node scripts/cf.mjs verify
//   node scripts/cf.mjs GET workers/observability/telemetry/query
//   node scripts/cf.mjs POST workers/observability/telemetry/query -d @query.json
//   node scripts/cf.mjs GET "user/tokens" -q per_page=50
import fs from "node:fs";

const ENV_FILE = ".env.local";
const BASE = "https://api.cloudflare.com/client/v4";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function die(msg) {
  console.error(`cf: ${msg}`);
  process.exit(1);
}

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  die(
    `could not read ${ENV_FILE}. Create it with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see .env.local.example).`
  );
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) die(`CLOUDFLARE_API_TOKEN missing in ${ENV_FILE}`);
if (!accountId) die(`CLOUDFLARE_ACCOUNT_ID missing in ${ENV_FILE}`);

// Never let the token leak into output, whatever the API echoes back.
const redact = (s) => (token ? s.split(token).join("***REDACTED***") : s);

const argv = process.argv.slice(2);
if (argv.length === 0) die("no command. Try: node scripts/cf.mjs verify");

let method = "GET";
let path;
let data;
const queries = [];
let raw = false;

if (argv[0] === "verify") {
  path = `/accounts/${accountId}/tokens/verify`;
  argv.shift();
} else {
  if (METHODS.has(argv[0]?.toUpperCase())) method = argv.shift().toUpperCase();
  path = argv.shift();
  if (!path) die("missing <path>");
}

while (argv.length) {
  const flag = argv.shift();
  switch (flag) {
    case "-d":
    case "--data":
      data = argv.shift();
      break;
    case "-q":
    case "--query":
      queries.push(argv.shift());
      break;
    case "--raw":
      raw = true;
      break;
    default:
      die(`unknown flag: ${flag}`);
  }
}

const apiPath = path.startsWith("/") ? path : `/accounts/${accountId}/${path}`;
const url = new URL(BASE + apiPath);
for (const q of queries) {
  const eq = q.indexOf("=");
  if (eq === -1) die(`bad --query (expected k=v): ${q}`);
  url.searchParams.append(q.slice(0, eq), q.slice(eq + 1));
}

let body;
if (data !== undefined) {
  body = data.startsWith("@") ? fs.readFileSync(data.slice(1), "utf8") : data;
}

const headers = { Authorization: `Bearer ${token}` };
if (body !== undefined) headers["Content-Type"] = "application/json";

console.error(`→ ${method} ${redact(url.pathname + url.search)}`);

const res = await fetch(url, { method, headers, body });
const text = await res.text();
console.error(`← ${res.status} ${res.statusText}`);

let out = redact(text);
if (!raw) {
  try {
    out = JSON.stringify(JSON.parse(out), null, 2);
  } catch {
    /* not JSON — print as-is */
  }
}
console.log(out);

if (!res.ok) process.exit(1);
