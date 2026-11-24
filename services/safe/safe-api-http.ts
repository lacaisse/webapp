// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { SafeError } from "@/services/safe/types";

// HTTP plumbing shared by the two Safe API clients: the Safe Transaction
// Service (tx-service.ts) and the Safe Queue Service (queue-service.ts). Both
// are served from api.safe.global and take the same key.
//
// `SAFE_API_KEY` (optional) is sent as a Bearer token; without it the hosted
// services allow a low unauthenticated rate. 10 s timeout per request. Every
// failure is a SafeError "tx_service" — the code the mirror bookkeeping in
// proposals.ts keys on, whichever service answered.

const TIMEOUT_MS = 10_000;

export type SafeApiResult = { status: number; text: string };

export async function sendSafeApi(
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<SafeApiResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const apiKey = process.env.SAFE_API_KEY?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    // Safe API keys can be restricted to domains (the dashboard's allowed
    // hosts, e.g. `lacaisse.eu` / `*.lacaisse.eu`); the service enforces that
    // on the Referer host and answers 403 "Your referer host is not allowed"
    // to a server-side call, which carries none. Identify as the apex so a
    // domain-restricted key still works from the server.
    const apex = process.env.APP_DOMAIN?.trim();
    if (apex && apex !== "localhost") headers.referer = `https://${apex}/`;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new SafeError("tx_service", `${method} ${path} failed: ${reason}`, { cause: e });
  }
  return { status: res.status, text: await res.text().catch(() => "") };
}

export function safeApiHttpError(method: string, path: string, r: SafeApiResult): SafeError {
  return new SafeError(
    "tx_service",
    `${method} ${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`,
  );
}

export function parseSafeApiJson(method: string, path: string, r: SafeApiResult): unknown {
  try {
    return JSON.parse(r.text);
  } catch {
    throw new SafeError("tx_service", `${method} ${path}: response is not JSON`);
  }
}

/** GET returning parsed JSON, or null on 404. */
export async function getSafeApiJson(base: string, path: string): Promise<unknown | null> {
  const r = await sendSafeApi(base, "GET", path);
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw safeApiHttpError("GET", path, r);
  return parseSafeApiJson("GET", path, r);
}
