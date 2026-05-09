import "server-only";

// WebAuthn (passkey) configuration helpers.
//
// rpID = the WebAuthn "Relying Party ID". MUST be the apex domain so a
// passkey registered on `acme.lacaisse.eu` works across every fund subdomain.
// In dev the rpID is `localhost`. This is the only domain a browser will
// scope passkeys to.
//
// Allowed origins = the full URLs that may legitimately initiate a ceremony.
// Any subdomain of the apex (and the apex itself) qualifies. We accept all
// `https?://(<sub>.)?<rpID>(:port)?` URLs.

export const RP_NAME = "La Caisse";

export function getRpID(): string {
  return process.env.APP_DOMAIN ?? "localhost";
}

export function getExpectedOrigin(requestOrigin: string | null): string[] {
  // Always allow the apex; allow the request's origin if it's a subdomain of
  // the apex (or the apex itself). We don't blindly trust the origin header,
  // we check it matches the expected RP scope first.
  const rpID = getRpID();
  const isProd = process.env.NODE_ENV === "production";
  const protocol = isProd ? "https" : "http";
  const port = isProd ? "" : `:${process.env.PORT ?? 3000}`;
  const allowed = new Set<string>([`${protocol}://${rpID}${port}`]);

  if (requestOrigin) {
    try {
      const url = new URL(requestOrigin);
      const host = url.hostname;
      if (host === rpID || host.endsWith(`.${rpID}`)) {
        allowed.add(requestOrigin);
      }
    } catch {
      // ignore malformed origin
    }
  }
  return [...allowed];
}

// WebAuthn requires a Uint8Array userID. We encode the uuid string as UTF-8
// bytes; on auth response we decode the user handle back to the uuid string.
// `.slice()` rebrands the type to `Uint8Array<ArrayBuffer>` to satisfy
// simplewebauthn's `Uint8Array_ = ReturnType<Uint8Array['slice']>` alias
// (a workaround for TS 5.7+ tightening ArrayBuffer typing).

export function userIdToBytes(userId: string) {
  return new TextEncoder().encode(userId).slice();
}

export function bytesToUserId(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
