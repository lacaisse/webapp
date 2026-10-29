#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end check of the MCP OAuth stack with the real MCP SDK client (the
// same code path Claude Code and the Inspector use), against a running dev
// server:
//
//   discovery (401 → protected-resource metadata → authorization-server
//   metadata) → dynamic client registration → PKCE authorize (printed URL:
//   open it, sign in, consent) → callback caught here → token → tools/list →
//   one tool call → refresh-token rotation → a call with the new token →
//   (with --cross) the token is refused by another host's /api/mcp.
//
// Usage:
//   node scripts/mcp-oauth-e2e.mjs [--server http://acme.localhost:3028/api/mcp]
//                                  [--port 9876] [--tool list_funds]
//                                  [--cross http://localhost:3028/api/mcp]
//                                  [--url-file /tmp/authorize-url.txt]
//
// `--url-file` also writes the authorize URL to a file (handy when the
// browser is driven by something other than the human reading stdout).
// Exits non-zero at the first step that fails.

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const serverUrl = new URL(args.server ?? "http://localhost:3028/api/mcp");
const port = Number(args.port ?? 9876);
const toolName = args.tool ?? "list_funds";
const redirectUrl = `http://localhost:${port}/callback`;

const log = (step, detail = "") => console.log(`✓ ${step}${detail ? ` — ${detail}` : ""}`);
const fail = (step, err) => {
  console.error(`✗ ${step}`);
  console.error(err);
  process.exit(1);
};

// --- In-memory OAuthClientProvider -----------------------------------------
let clientInformation;
let tokens;
let codeVerifier;
let authorizationUrl;
const stateValue = randomBytes(16).toString("hex");

const provider = {
  get redirectUrl() {
    return redirectUrl;
  },
  get clientMetadata() {
    return {
      client_name: "La Caisse MCP e2e",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  state: () => stateValue,
  clientInformation: () => clientInformation,
  saveClientInformation: (info) => {
    clientInformation = info;
  },
  tokens: () => tokens,
  saveTokens: (t) => {
    tokens = t;
  },
  redirectToAuthorization: (url) => {
    authorizationUrl = url;
  },
  saveCodeVerifier: (v) => {
    codeVerifier = v;
  },
  codeVerifier: () => codeVerifier,
  invalidateCredentials: (scope) => {
    if (scope === "all" || scope === "client") clientInformation = undefined;
    if (scope === "all" || scope === "tokens") tokens = undefined;
    if (scope === "all" || scope === "verifier") codeVerifier = undefined;
  },
};

// --- Callback listener ------------------------------------------------------
const waitForCode = () =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "content-type": "text/plain" }).end(`error: ${error}`);
        server.close();
        reject(new Error(`${error}: ${url.searchParams.get("error_description")}`));
        return;
      }
      if (url.searchParams.get("state") !== stateValue) {
        res.writeHead(400).end("state mismatch");
        server.close();
        reject(new Error("state mismatch"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<p>Authorized — you can close this tab.</p>");
      server.close();
      resolve(url.searchParams.get("code"));
    });
    server.listen(port);
  });

const connect = async () => {
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: provider,
  });
  const client = new Client({ name: "la-caisse-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
};

// --- The flow --------------------------------------------------------------
const pendingCode = waitForCode();

let session;
try {
  session = await connect();
  console.warn("! connected without authorization — is the endpoint protected?");
  process.exit(1);
} catch (e) {
  if (!(e instanceof UnauthorizedError)) fail("initial connect (expected 401 challenge)", e);
}
if (!clientInformation?.client_id) fail("dynamic client registration", "no client_id saved");
log("discovery + dynamic registration", `client_id=${clientInformation.client_id}`);
if (!authorizationUrl) fail("authorize redirect", "no authorization URL");
const authParams = new URL(authorizationUrl).searchParams;
log(
  "PKCE authorize URL",
  `resource=${authParams.get("resource")} scope=${authParams.get("scope")} code_challenge_method=${authParams.get("code_challenge_method")}`,
);
if (args["url-file"]) writeFileSync(args["url-file"], authorizationUrl.toString());
console.log(`\nOpen this URL, sign in and authorize:\n\n${authorizationUrl}\n`);

let code;
try {
  code = await pendingCode;
} catch (e) {
  fail("authorization callback", e);
}
log("authorization callback", `code=${code.slice(0, 8)}…`);

try {
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: provider,
  });
  await transport.finishAuth(code);
} catch (e) {
  fail("token exchange", e);
}
if (!tokens?.access_token) fail("token exchange", "no access token saved");
const firstAccessToken = tokens.access_token;
log(
  "token exchange",
  `token_type=${tokens.token_type} expires_in=${tokens.expires_in} refresh_token=${tokens.refresh_token ? "yes" : "NO"} scope=${tokens.scope ?? "(none)"}`,
);
const [, payload] = firstAccessToken.split(".");
if (payload) {
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  log("access token claims", `iss=${claims.iss} aud=${JSON.stringify(claims.aud)} sub=${claims.sub} azp=${claims.azp}`);
}

try {
  session = await connect();
} catch (e) {
  fail("authenticated connect", e);
}
log("authenticated connect", `server=${session.client.getServerVersion()?.name}`);

let toolNames;
try {
  const { tools } = await session.client.listTools();
  toolNames = tools.map((t) => t.name);
} catch (e) {
  fail("tools/list", e);
}
log("tools/list", `${toolNames.length} tools: ${toolNames.slice(0, 6).join(", ")}…`);

try {
  const result = await session.client.callTool({ name: toolName, arguments: {} });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  log(`tools/call ${toolName}`, `isError=${result.isError ?? false} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
} catch (e) {
  fail(`tools/call ${toolName}`, e);
}
await session.transport.close();

// Refresh: auth() with a stored refresh token rotates it at /oauth2/token.
if (!tokens.refresh_token) fail("refresh", "no refresh token to rotate");
try {
  const outcome = await auth(provider, { serverUrl });
  if (outcome !== "AUTHORIZED") fail("refresh", `auth() returned ${outcome}`);
} catch (e) {
  fail("refresh", e);
}
if (tokens.access_token === firstAccessToken) fail("refresh", "access token did not change");
log("refresh token rotation", `new access token, refresh_token=${tokens.refresh_token ? "rotated" : "MISSING"}`);

try {
  session = await connect();
  const { tools } = await session.client.listTools();
  log("call with refreshed token", `${tools.length} tools`);
  await session.transport.close();
} catch (e) {
  fail("call with refreshed token", e);
}

// Audience binding: the token was minted for this host's resource only.
if (args.cross) {
  try {
    const res = await fetch(args.cross, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    if (res.status !== 401) fail("cross-host audience check", `expected 401 from ${args.cross}, got ${res.status}`);
    log("cross-host audience check", `${args.cross} → 401 ${res.headers.get("www-authenticate")?.slice(0, 60)}…`);
  } catch (e) {
    fail("cross-host audience check", e);
  }
}

console.log("\nAll steps passed.");
process.exit(0);
