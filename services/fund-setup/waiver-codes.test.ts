// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  WAIVER_CODE_ALPHABET,
  WAIVER_CODE_LENGTH,
  formatWaiverCode,
  generateWaiverCode,
  isWellFormedWaiverCode,
  normaliseWaiverCode,
  waiverCodeState,
} from "./waiver-codes";

describe("generateWaiverCode", () => {
  it("is 12 symbols of the alphabet, and not the same twice", () => {
    const a = generateWaiverCode();
    const b = generateWaiverCode();
    expect(a).toHaveLength(WAIVER_CODE_LENGTH);
    for (const ch of a) expect(WAIVER_CODE_ALPHABET).toContain(ch);
    expect(isWellFormedWaiverCode(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("never contains the letters that read like digits", () => {
    expect(WAIVER_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(WAIVER_CODE_ALPHABET).toHaveLength(32);
  });
});

describe("normaliseWaiverCode", () => {
  it("drops case, spaces and separators", () => {
    expect(normaliseWaiverCode(" 7k3p-m2qx 9rtd\n")).toBe("7K3PM2QX9RTD");
  });

  it("maps O to 0 and I / L to 1", () => {
    expect(normaliseWaiverCode("oil-OIL")).toBe("011011");
  });

  it("survives the formatted spelling round trip", () => {
    const code = generateWaiverCode();
    expect(normaliseWaiverCode(formatWaiverCode(code))).toBe(code);
  });
});

describe("formatWaiverCode", () => {
  it("groups by four", () => {
    expect(formatWaiverCode("7K3PM2QX9RTD")).toBe("7K3P-M2QX-9RTD");
  });
});

describe("isWellFormedWaiverCode", () => {
  it("wants exactly the length and the alphabet", () => {
    expect(isWellFormedWaiverCode("7K3PM2QX9RTD")).toBe(true);
    expect(isWellFormedWaiverCode("7K3PM2QX9RT")).toBe(false);
    expect(isWellFormedWaiverCode("7K3PM2QX9RTDA")).toBe(false);
    expect(isWellFormedWaiverCode("7K3PM2QX9RTU")).toBe(false);
    expect(isWellFormedWaiverCode("7k3pm2qx9rtd")).toBe(false); // normalise first
  });
});

describe("waiverCodeState", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const base = { revokedAt: null, expiresAt: null, maxUses: 1, usedCount: 0 };

  it("is active with a use left, no expiry, not revoked", () => {
    expect(waiverCodeState(base, now)).toBe("active");
    expect(waiverCodeState({ ...base, expiresAt: new Date("2026-12-01T00:00:00Z") }, now)).toBe("active");
    expect(waiverCodeState({ ...base, maxUses: 3, usedCount: 2 }, now)).toBe("active");
  });

  it("is exhausted once every use is taken", () => {
    expect(waiverCodeState({ ...base, usedCount: 1 }, now)).toBe("exhausted");
    expect(waiverCodeState({ ...base, maxUses: 3, usedCount: 3 }, now)).toBe("exhausted");
  });

  it("is expired at and after the expiry instant", () => {
    expect(waiverCodeState({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(waiverCodeState({ ...base, expiresAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe("expired");
  });

  it("revoked beats expired beats exhausted", () => {
    const spent = { ...base, usedCount: 1, expiresAt: new Date("2026-01-01T00:00:00Z") };
    expect(waiverCodeState(spent, now)).toBe("expired");
    expect(waiverCodeState({ ...spent, revokedAt: now }, now)).toBe("revoked");
  });
});
