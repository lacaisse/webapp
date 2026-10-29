// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  ADDRESS,
  ExternalOwnerSchema,
  ProposeOwnerChangeSchema,
  ProposeTransferSchema,
  RenameSafeSchema,
  stripInvisible,
} from "./schemas";

const base = {
  safeId: "safe-1",
  recipient: "0x9999999999999999999999999999999999999999",
  amount: "1",
};

describe("ProposeTransferSchema.token", () => {
  it("defaults to the fund token", () => {
    expect(ProposeTransferSchema.parse(base).token).toBe("fund");
  });

  it("accepts the built-ins and a lowercase custom:<address> key", () => {
    for (const token of [
      "fund",
      "native",
      "eure",
      "custom:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0",
    ]) {
      expect(ProposeTransferSchema.parse({ ...base, token }).token).toBe(token);
    }
  });

  it("refuses anything else", () => {
    for (const token of [
      "usdc",
      "custom:0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", // not lowercased
      "custom:0x1234",
      "custom:",
    ]) {
      const res = ProposeTransferSchema.safeParse({ ...base, token });
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toBe("fund.safes.errors.tokenNotEnabled");
    }
  });
});

describe("invisible / bidi characters in proposer text", () => {
  const RLO = "\u202E"; // right-to-left override
  const ZWSP = "\u200B"; // zero-width space

  it("stripInvisible removes format characters and trims", () => {
    expect(stripInvisible(` ${ZWSP}Ba${RLO}kery\u2066\u00AD${ZWSP} `)).toBe("Bakery");
    expect(stripInvisible("Café — Zinne")).toBe("Café — Zinne");
  });

  it("labels and notes come out clean", () => {
    const transfer = ProposeTransferSchema.parse({
      ...base,
      recipientLabel: `${RLO}yrekaB${ZWSP}`,
      note: ` rent${ZWSP} `,
    });
    expect(transfer.recipientLabel).toBe("yrekaB");
    expect(transfer.note).toBe("rent");
    expect(
      ExternalOwnerSchema.parse({ address: base.recipient, label: `Audi${ZWSP}tor${RLO}` }).label,
    ).toBe("Auditor");
    const owner = ProposeOwnerChangeSchema.parse({
      safeId: "safe-1",
      change: { kind: "ADD_OWNER", address: base.recipient, label: `${RLO}Ext`, threshold: 1 },
      note: `${ZWSP}why`,
    });
    expect(owner.note).toBe("why");
    expect(owner.change.kind === "ADD_OWNER" && owner.change.label).toBe("Ext");
  });

  it("measures max length after stripping, and a name of only invisibles is empty", () => {
    // 60 visible characters padded with invisibles: accepted (and cleaned).
    const padded = `${RLO.repeat(10)}${"a".repeat(60)}${ZWSP.repeat(10)}`;
    expect(RenameSafeSchema.parse({ safeId: "s", name: padded }).name).toBe("a".repeat(60));
    expect(ExternalOwnerSchema.parse({ address: base.recipient, label: padded }).label).toHaveLength(60);
    // 61 visible characters: refused with the usual key.
    const long = RenameSafeSchema.safeParse({ safeId: "s", name: `${"a".repeat(61)}${ZWSP}` });
    expect(long.error?.issues[0]?.message).toBe("fund.safes.errors.nameTooLong");
    const empty = RenameSafeSchema.safeParse({ safeId: "s", name: `${RLO}${ZWSP} ` });
    expect(empty.error?.issues[0]?.message).toBe("fund.safes.errors.nameRequired");
  });
});

describe("ADDRESS checksum (EIP-55)", () => {
  const lower = "0x8ad5a865cc1942b1b2b36c186403f89bff512aa0";
  const good = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
  const bad = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aa0"; // last 'A' lowered

  it("accepts lowercase and a correct mixed-case checksum", () => {
    expect(ADDRESS.safeParse(lower).success).toBe(true);
    expect(ADDRESS.safeParse(good).success).toBe(true);
    expect(ADDRESS.safeParse(` ${good} `).success).toBe(true);
  });

  it("refuses a mixed-case address with a wrong checksum", () => {
    const res = ADDRESS.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]!.message).toBe("fund.safes.errors.addressChecksum");
    }
  });
});
