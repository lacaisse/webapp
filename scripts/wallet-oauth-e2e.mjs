#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A minimal stand-in for the Citizen Pay card wallet as an OAuth client of La
// Caisse (plan "Bread card-holder voting", D5), against a running dev server:
//
//   authorization code + PKCE (confidential client, client_secret_basic,
//   RFC 8707 `resource` = the api audience, `fund=<slug>` hint) → the
//   callback caught here → token exchange → the decoded access token and ID
//   token printed → refresh-token rotation → a second authorize with
//   `prompt=login max_age=0`, which must ask for the password again and
//   yield a newer `auth_time`.
//
// Usage:
//   WALLET_OAUTH_CLIENT_SECRET=… node scripts/wallet-oauth-e2e.mjs \
//     [--issuer http://auth.localhost:3032/api/auth] \
//     [--resource http://localhost:4455/api] [--fund alpha] [--port 4455]
//
// The registered redirect URI is http://localhost:3000/auth/callback; the
// provider matches loopback redirects on any port (RFC 8252), so this script
// may listen anywhere. Exits non-zero at the first step that fails.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const issuer = (args.issuer ?? "http://auth.localhost:3032/api/auth").replace(/\/$/, "");
const resource = args.resource ?? "http://localhost:4455/api";
const fund = args.fund ?? "alpha";
const port = Number(args.port ?? 4455);
const redirectUri = `http://localhost:${port}/auth/callback`;
const clientId = "citizenpay-wallet";
const clientSecret = process.env.WALLET_OAUTH_CLIENT_SECRET;
if (!clientSecret) {
  console.error("WALLET_OAUTH_CLIENT_SECRET is required (the same value the server has).");
  process.exit(1);
}

const clean = (s) => String(s).replace(/[\r\n\t]+/g, " ");
const log = (step, detail = "") => console.log(`✓ ${step}${detail ? ` — ${clean(detail)}` : ""}`);
const fail = (step, err) => {
  console.error(`✗ ${step}`);
  console.error(err);
  process.exit(1);
};
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const decodeJwt = (jwt) => {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
  };
};

const waitForCode = (expectedState) =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/auth/callback") {
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
      if (url.searchParams.get("state") !== expectedState) {
        res.writeHead(400).end("state mismatch");
        server.close();
        reject(new Error("state mismatch"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<p>Authorized — back to the terminal.</p>");
      server.close();
      resolve({ code: url.searchParams.get("code"), iss: url.searchParams.get("iss") });
    });
    server.listen(port);
  });

async function authorize(extra = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    fund,
    ...extra,
  });
  const url = `${issuer}/oauth2/authorize?${params}`;
  console.log(`\nOpen this URL in the browser and sign in:\n${url}\n`);
  const pending = waitForCode(state);
  const { code, iss } = await pending;
  log("authorization code received", `iss=${iss}`);
  return exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, resource });
}

async function exchange(body) {
  const res = await fetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function show(tokens, label) {
  const at = decodeJwt(tokens.access_token);
  console.log(`\n${label}: access token (${at.header.alg}, kid ${at.header.kid ?? "-"})`);
  console.log(JSON.stringify(at.payload, null, 2));
  if (tokens.id_token) {
    const idt = decodeJwt(tokens.id_token);
    console.log(`${label}: id token`);
    console.log(JSON.stringify(idt.payload, null, 2));
    return { access: at.payload, id: idt.payload };
  }
  return { access: at.payload, id: null };
}

try {
  const first = await authorize();
  const a = show(first, "first login");
  const ttl = a.access.exp - a.access.iat;
  log("access token", `aud=${JSON.stringify(a.access.aud)} sub=${a.access.sub} email=${a.access.email} ttl=${ttl}s`);
  if (!first.refresh_token) fail("refresh token", "none issued (offline_access?)");
  log("id token", `auth_time=${a.id?.auth_time}`);

  const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, resource });
  const r = show(refreshed, "after refresh");
  log("refresh rotated", refreshed.refresh_token !== first.refresh_token ? "new refresh token" : "SAME refresh token");
  if (r.id) log("id token after refresh", `auth_time=${r.id.auth_time} (${r.id.auth_time === a.id?.auth_time ? "unchanged" : "CHANGED"})`);

  // The @better-auth/mcp preset sets refreshTokenReuseInterval = 30: for 30 s
  // after a rotation the OLD token still answers with the same response
  // (RFC 9700 §4.14.2 replay tolerance for a lost reply); after that any
  // reuse is a replay and revokes the whole family.
  const reused = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, resource }).then(
    (again) =>
      again.access_token === refreshed.access_token
        ? "same response replayed (inside the 30 s reuse interval)"
        : "accepted with a DIFFERENT response (!)",
    (e) => `refused: ${e.message.slice(0, 80)}`,
  );
  log("old refresh token", reused);

  await new Promise((r) => setTimeout(r, 1100));
  console.log("\nSecond round: prompt=login max_age=0 — the login page must ask for the password again.");
  const second = await authorize({ prompt: "login", max_age: "0" });
  const s = show(second, "after prompt=login");
  log("auth_time refreshed", `${a.id?.auth_time} → ${s.id?.auth_time} (${(s.id?.auth_time ?? 0) > (a.id?.auth_time ?? 0) ? "newer" : "NOT newer"})`);
  process.exit(0);
} catch (e) {
  fail("wallet oauth e2e", e);
}
