// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Shared, non-action pieces of the embeds feature: the domain-allowlist
// grammar, the public-widget limits, and the slug minter. Plain module (no
// "use server") so the settings form and the server actions can both import
// it — `npm run guard` rejects non-async exports from action files.

// A generous ceiling, not a product constraint: the list is joined into a
// response header on every fund request, so it should stay short enough that
// nobody can bloat the header by pasting a list of hundreds of domains.
export const MAX_EMBED_DOMAINS = 20;

// How many transfers the public account widget shows. There is deliberately no
// pagination on the widget — exposing a cursor would turn a "recent activity"
// snippet into a full public export of the account's history.
export const PUBLIC_TRANSFER_COUNT = 10;

// One CSP host-source: an optional `*.` wildcard prefix, dot-separated DNS
// labels, and an optional port. Scheme-less on purpose — a bare host-source
// matches both http and https, which is what lets one stored value work for
// `http://localhost:8080` in dev and `https://example.org` in production.
//
// This regex is the security boundary for the header: it admits no whitespace,
// no `;` and no `'`, so a stored value cannot terminate the directive or add
// one of its own. Never widen it without re-checking proxy.ts.
const HOST_SOURCE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Normalise one admin-entered line into a CSP host-source, or `null` when it
 * isn't one. Accepts what someone would naturally paste — a full URL, a
 * trailing slash, mixed case, stray whitespace — and reduces it to host[:port].
 *
 * Deliberately rejects a bare `*` (that would let any site on the internet
 * frame the widget, which is never what an allowlist is for) and `*` in any
 * position other than a leading `*.` label.
 */
export function normalizeEmbedDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Drop a scheme if the admin pasted a URL.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Drop credentials, then anything from the first path/query/fragment char on.
  value = value.replace(/^[^/@]*@/, "");
  value = value.split(/[/?#]/)[0];
  // A trailing dot is a legal FQDN but not a legal CSP host-source.
  value = value.replace(/\.$/, "");

  if (!value || value === "*") return null;
  if (!HOST_SOURCE.test(value)) return null;
  return value;
}

/**
 * Split the settings textarea into candidate domains: one per line, blanks
 * dropped. Commas are tolerated as separators too — pasting a comma-separated
 * list is the obvious mistake to make with a one-per-line field.
 */
export function splitEmbedDomainLines(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The normalised, de-duplicated allowlist for a textarea's contents. Assumes
 * the input already passed `EmbedDomainsSchema` — invalid lines are dropped
 * rather than reported, so validate first if you need to tell the admin why.
 */
export function parseEmbedDomains(raw: string): string[] {
  const seen = new Set<string>();
  for (const line of splitEmbedDomainLines(raw)) {
    const normalized = normalizeEmbedDomain(line);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

// Error messages are i18n keys, resolved by the caller (see AGENTS.md).
export const EmbedDomainsSchema = z.object({
  domains: z.string().superRefine((raw, ctx) => {
    const lines = splitEmbedDomainLines(raw);
    if (lines.length > MAX_EMBED_DOMAINS) {
      ctx.addIssue({
        code: "custom",
        message: "settings.errors.embedDomainsTooMany",
      });
      return;
    }
    if (lines.some((line) => normalizeEmbedDomain(line) === null)) {
      ctx.addIssue({
        code: "custom",
        message: "settings.errors.embedDomainInvalid",
      });
    }
  }),
});

export const AccountEmbedSchema = z.object({
  accountId: z.string().min(1),
  enabled: z.boolean(),
});

export const RotateAccountEmbedSchema = z.object({
  accountId: z.string().min(1),
});

/**
 * Mint a public embed handle: 128 bits of randomness as lowercase hex. This
 * token is the only thing standing between the internet and the account
 * widget, so it must not be guessable or derived from anything about the
 * account (id, name, address).
 *
 * Uses the Web Crypto global rather than `node:crypto` on purpose — this
 * module is imported by the settings form, and a `node:` import would follow
 * it into the client bundle.
 */
export function generateEmbedSlug(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
