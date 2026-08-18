// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  EmbedDomainsSchema,
  MAX_EMBED_DOMAINS,
  generateEmbedSlug,
  normalizeEmbedDomain,
  parseEmbedDomains,
} from "./schema";

// The allowlist is joined straight into a `frame-ancestors` header, so these
// tests are as much a security boundary as a parsing convenience: anything
// that gets through here ends up in a response header verbatim.

describe("normalizeEmbedDomain", () => {
  it("accepts a plain hostname", () => {
    expect(normalizeEmbedDomain("example.org")).toBe("example.org");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(normalizeEmbedDomain("  Example.ORG  ")).toBe("example.org");
  });

  it("strips a scheme and path from a pasted URL", () => {
    expect(normalizeEmbedDomain("https://example.org/some/page?a=1")).toBe(
      "example.org",
    );
  });

  it("keeps an explicit port", () => {
    expect(normalizeEmbedDomain("http://localhost:8080")).toBe("localhost:8080");
    expect(normalizeEmbedDomain("127.0.0.1:8080")).toBe("127.0.0.1:8080");
  });

  it("accepts a leading wildcard label", () => {
    expect(normalizeEmbedDomain("*.example.org")).toBe("*.example.org");
  });

  it("drops a trailing FQDN dot", () => {
    expect(normalizeEmbedDomain("example.org.")).toBe("example.org");
  });

  it("rejects a bare wildcard", () => {
    // Allowing this would let any site on the internet frame the widget.
    expect(normalizeEmbedDomain("*")).toBeNull();
  });

  it("rejects a wildcard anywhere but the leading label", () => {
    expect(normalizeEmbedDomain("example.*")).toBeNull();
    expect(normalizeEmbedDomain("foo.*.example.org")).toBeNull();
  });

  it("rejects values that could break out of the CSP directive", () => {
    expect(normalizeEmbedDomain("example.org; script-src *")).toBeNull();
    expect(normalizeEmbedDomain("example.org evil.example")).toBeNull();
    expect(normalizeEmbedDomain("'self'")).toBeNull();
    expect(normalizeEmbedDomain("example.org\nevil.example")).toBeNull();
  });

  it("rejects empty and malformed hosts", () => {
    expect(normalizeEmbedDomain("")).toBeNull();
    expect(normalizeEmbedDomain("   ")).toBeNull();
    expect(normalizeEmbedDomain("-example.org")).toBeNull();
    expect(normalizeEmbedDomain("example..org")).toBeNull();
    expect(normalizeEmbedDomain("example.org:notaport")).toBeNull();
  });
});

describe("parseEmbedDomains", () => {
  it("splits on newlines and commas, normalising each entry", () => {
    expect(parseEmbedDomains("Example.org\nhttps://foo.test/\n, bar.test")).toEqual([
      "example.org",
      "foo.test",
      "bar.test",
    ]);
  });

  it("de-duplicates entries that normalise to the same host", () => {
    expect(parseEmbedDomains("example.org\nhttps://example.org/page")).toEqual([
      "example.org",
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseEmbedDomains("\n\n   \n")).toEqual([]);
  });
});

describe("EmbedDomainsSchema", () => {
  it("accepts a valid list", () => {
    expect(
      EmbedDomainsSchema.safeParse({ domains: "example.org\n*.foo.test" })
        .success,
    ).toBe(true);
  });

  it("accepts an empty list (widgets off)", () => {
    expect(EmbedDomainsSchema.safeParse({ domains: "" }).success).toBe(true);
  });

  it("reports an i18n key for an invalid entry", () => {
    const result = EmbedDomainsSchema.safeParse({
      domains: "example.org\nnot a domain",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "settings.errors.embedDomainInvalid",
      );
    }
  });

  it("reports an i18n key when the list is too long", () => {
    const result = EmbedDomainsSchema.safeParse({
      domains: Array.from(
        { length: MAX_EMBED_DOMAINS + 1 },
        (_, i) => `site${i}.test`,
      ).join("\n"),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "settings.errors.embedDomainsTooMany",
      );
    }
  });
});

describe("generateEmbedSlug", () => {
  it("mints a 128-bit URL-safe token", () => {
    const slug = generateEmbedSlug();
    expect(slug).toMatch(/^[0-9a-f]{32}$/);
    expect(encodeURIComponent(slug)).toBe(slug);
  });

  it("does not repeat", () => {
    const slugs = new Set(Array.from({ length: 100 }, generateEmbedSlug));
    expect(slugs.size).toBe(100);
  });
});
