// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";

// Signature of the Citizen Pay treasury events webhook (api PR P,
// `internal/service/treasury_events.go`): every delivery carries
// `X-CitizenPay-Timestamp` and `X-CitizenPay-Signature =
// HMAC-SHA256(secret, timestamp + "." + rawBody)`, hex. The receiver
// (app/api/citizenpay/events) checks the signature against the fund's
// registered secret with a constant-time compare and refuses a timestamp
// more than five minutes away from its own clock, so a captured delivery
// cannot be replayed later. Pure — no server-only, unit-tested on its own.

export const EVENTS_TIMESTAMP_HEADER = "x-citizenpay-timestamp";
export const EVENTS_SIGNATURE_HEADER = "x-citizenpay-signature";
export const EVENTS_MAX_SKEW_MS = 5 * 60 * 1000;

export function signEventsPayload(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

/**
 * The timestamp header as a Date. The api sends unix seconds; unix
 * milliseconds and RFC 3339 are read too so a change of spelling on the api
 * side does not turn every delivery into a 401. Null when unreadable.
 */
export function parseEventsTimestamp(raw: string | null): Date | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return null;
    // Anything below 10^12 is seconds (that is the year 33658 in ms).
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export type EventsSignatureCheck =
  | "ok"
  | "missing" // a header is absent
  | "bad_timestamp" // the timestamp header is unreadable
  | "skew" // the timestamp is too far from now
  | "mismatch"; // the signature does not match the body

/**
 * Check one delivery. The skew check runs before the compare so the result
 * names the reason; neither leaks anything about the secret. `signature` may
 * carry a `sha256=` prefix.
 */
export function verifyEventsSignature(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
  maxSkewMs?: number;
}): EventsSignatureCheck {
  if (args.timestamp === null || args.signature === null) return "missing";
  const at = parseEventsTimestamp(args.timestamp);
  if (at === null) return "bad_timestamp";
  const now = args.now ?? new Date();
  const maxSkew = args.maxSkewMs ?? EVENTS_MAX_SKEW_MS;
  if (Math.abs(now.getTime() - at.getTime()) > maxSkew) return "skew";

  const expected = signEventsPayload(args.secret, args.timestamp.trim(), args.rawBody);
  const given = args.signature.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(given)) return "mismatch";
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length) return "mismatch";
  return timingSafeEqual(a, b) ? "ok" : "mismatch";
}
