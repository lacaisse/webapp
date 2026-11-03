// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";

import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  WALLET_ACCESS_TOKEN_TTL,
  WALLET_CLIENT_ID,
  hashClientSecret,
  oauthProviderOptions,
  walletAudienceResourceRow,
  walletOauthClientRow,
} from "./oauth-provider-config";

// The card wallet's OAuth flow against the REAL provider plugin, with the
// options production runs (oauthProviderOptions) on the memory adapter: a
// member User — no FundMember row anywhere — completes authorization code +
// PKCE as the static confidential client, consent skipped; the access token
// is a JWT with `sub` = the user id, `aud` naming the api audience (RFC 8707
// `resource`; with `openid` in scope the provider makes `aud` an array that
// also lists its own userinfo endpoint — the api matches on containment),
// `email` / `email_verified`, 15 min; the ID token carries
// `auth_time`; refresh tokens rotate; `prompt=login max_age=0` sends the
// user back to the login page (with the `fund` hint intact) and a new
// credential entry yields a newer `auth_time`.

const ORIGIN = "http://auth.localhost:3000";
const ISSUER = `${ORIGIN}/api/auth`;
const MCP_RESOURCE = "http://localhost:3000/api/mcp";
const AUDIENCE = "http://localhost:4455/api";
const REDIRECT_URI = "http://localhost:3000/auth/callback";
const SECRET = "wallet-test-secret";
const EMAIL = "member@example.org";
const PASSWORD = "correct horse battery";

const tables = [
  "user", "session", "account", "verification", "jwks",
  "oauthClient", "oauthResource", "oauthClientResource",
  "oauthRefreshToken", "oauthAccessToken", "oauthConsent", "oauthClientAssertion",
];
const db: Record<string, unknown[]> = Object.fromEntries(tables.map((t) => [t, []]));

const auth = betterAuth({
  baseURL: ORIGIN,
  secret: "test-better-auth-secret-at-least-32-chars-long",
  database: memoryAdapter(db),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt({ disableSettingJwtHeader: true }),
    mcp(oauthProviderOptions({ mcpResource: MCP_RESOURCE })),
  ],
});

const b64url = (buf: Buffer) => buf.toString("base64url");
const audienceList = (aud: unknown): string[] =>
  Array.isArray(aud) ? (aud as string[]) : typeof aud === "string" ? [aud] : [];
const sha256 = (s: string) => b64url(createHash("sha256").update(s).digest());
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: sha256(verifier) };
};

let userId: string;
let cookie: string;

async function signIn(extraBody: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const res = await auth.handler(
    new Request(`${ISSUER}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, ...extraBody }),
    }),
  );
  const session = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.includes("session_token"));
  return { res, cookie: session ?? "" };
}

function authorizeUrl(extra: Record<string, string>, challenge: string, state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: WALLET_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state,
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: AUDIENCE,
    fund: "alpha",
    ...extra,
  });
  return `${ISSUER}/oauth2/authorize?${params}`;
}

async function token(body: Record<string, string>) {
  const res = await auth.handler(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${WALLET_CLIENT_ID}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function codeFromAuthorize(url: string, withCookie: string) {
  const res = await auth.handler(new Request(url, { headers: { cookie: withCookie } }));
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  return new URL(location);
}

beforeAll(async () => {
  const signedUp = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: "Ada Member" },
  });
  userId = signedUp.user.id;
  // The member verified their email (the sign-up flow's verification link).
  const ctx = await auth.$context;
  await ctx.adapter.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: { emailVerified: true },
  });
  // The rows services/member/wallet-client.ts writes in production.
  const cfg = { clientSecret: SECRET, redirectUris: [REDIRECT_URI], audience: AUDIENCE };
  await ctx.adapter.create({ model: "oauthClient", data: walletOauthClientRow(cfg) });
  await ctx.adapter.create({ model: "oauthResource", data: walletAudienceResourceRow(cfg) });
  ({ cookie } = await signIn());
  expect(cookie).not.toBe("");
});

describe("wallet OAuth client (real provider, memory adapter)", () => {
  let firstRefresh: string;
  let firstAuthTime: number;

  it("hashes the client secret the way the provider verifies it", async () => {
    // Pinned by the token exchange below succeeding with client_secret_basic;
    // this is the shape of what the row holds.
    expect(hashClientSecret("abc")).toBe(sha256("abc"));
    expect(hashClientSecret("abc")).not.toContain("=");
  });

  it("issues a code to a member User without consent, exchanges it for a 15 min JWT bound to the api", async () => {
    const { verifier, challenge } = pkce();
    const redirect = await codeFromAuthorize(authorizeUrl({}, challenge, "s1"), cookie);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("s1");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const { status, json } = await token({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    expect(status).toBe(200);
    expect(json.expires_in).toBe(WALLET_ACCESS_TOKEN_TTL);
    expect(typeof json.refresh_token).toBe("string");
    firstRefresh = json.refresh_token as string;

    const jwksRes = await auth.handler(new Request(`${ISSUER}/jwks`));
    const jwks = createLocalJWKSet(await jwksRes.json());
    const { payload, protectedHeader } = await jwtVerify(json.access_token as string, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload.sub).toBe(userId);
    expect(audienceList(payload.aud)).toContain(AUDIENCE);
    expect(payload.email).toBe(EMAIL);
    expect(payload.email_verified).toBe(true);
    expect(payload.client_id).toBe(WALLET_CLIENT_ID);
    expect(payload.scope).toBe("openid profile email offline_access");
    expect(payload.exp! - payload.iat!).toBe(WALLET_ACCESS_TOKEN_TTL);
    // The provider reserves auth_time on access tokens: it lives in the ID token.
    expect(payload.auth_time).toBeUndefined();

    const idToken = decodeJwt(json.id_token as string);
    expect(idToken.sub).toBe(userId);
    expect(idToken.aud).toBe(WALLET_CLIENT_ID);
    expect(typeof idToken.auth_time).toBe("number");
    firstAuthTime = idToken.auth_time as number;
  });

  it("rotates the refresh token and keeps the audience", async () => {
    const { status, json } = await token({
      grant_type: "refresh_token",
      refresh_token: firstRefresh,
      resource: AUDIENCE,
    });
    expect(status).toBe(200);
    expect(json.refresh_token).not.toBe(firstRefresh);
    const payload = decodeJwt(json.access_token as string);
    expect(audienceList(payload.aud)).toContain(AUDIENCE);
    expect(payload.sub).toBe(userId);
    if (json.id_token) {
      // A refresh never re-authenticates: auth_time stays what it was.
      expect(decodeJwt(json.id_token as string).auth_time).toBe(firstAuthTime);
    }
  });

  it("prompt=login max_age=0 re-authenticates (fund hint intact) and refreshes auth_time", async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const { verifier, challenge } = pkce();
    const res = await auth.handler(
      new Request(authorizeUrl({ prompt: "login", max_age: "0" }, challenge, "s2"), {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!, ORIGIN);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("sig")).toBeTruthy();
    // The hint rides along in the signed query the login page reads.
    expect(login.searchParams.get("fund")).toBe("alpha");

    // The login page's password sign-in hands the signed query back; the
    // plugin resumes the authorize inside the sign-in call.
    const resumed = await signIn(
      { oauth_query: login.search.slice(1) },
      { accept: "application/json", cookie },
    );
    let next: string | null = resumed.res.headers.get("location");
    if (!next) next = ((await resumed.res.json()) as { url?: string }).url ?? null;
    expect(next).toBeTruthy();
    const redirect = new URL(next!);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    const code = redirect.searchParams.get("code")!;

    const { status, json } = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: AUDIENCE,
    });
    expect(status).toBe(200);
    const idToken = decodeJwt(json.id_token as string);
    expect(idToken.auth_time as number).toBeGreaterThan(firstAuthTime);
  });

  it("refuses the code without PKCE and refuses an unregistered audience", async () => {
    const { challenge } = pkce();
    const bad = await auth.handler(
      new Request(authorizeUrl({ resource: "http://evil.example/api" }, challenge, "s3"), {
        headers: { cookie },
      }),
    );
    expect(bad.status).toBe(302);
    const loc = new URL(bad.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_target");

    const noPkce = await auth.handler(
      new Request(authorizeUrl({ code_challenge: "", code_challenge_method: "" }, "", "s4"), {
        headers: { cookie },
      }),
    );
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });
});
