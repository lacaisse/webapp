// SPDX-License-Identifier: AGPL-3.0-or-later
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { COW_CONTRACTS_BY_CHAIN } from "./assets";
import {
  APP_DATA_DOC,
  APP_DATA_HASH,
  ERC20_APPROVE_ABI,
  GPV2_SETTLEMENT_ABI,
  appDataHash,
  applySlippage,
  erc20ApproveData,
  orderDigest,
  orderFromJson,
  orderFromQuote,
  orderToJson,
  orderUid,
  parseOrderUid,
  setPreSignatureData,
  type CowOrder,
} from "./cow-order";
import type { Hex } from "./types";

// Offline vector captured from the CoW orderbook (api.cow.fi/xdai) on
// 2026-11-02: the pre-sign order the GnosisDAO Safe placed through
// Safe{Wallet} on 2026-08-06 (USDC → sDAI), pre-signed in the batch that
// services/safe/safe-tx.test.ts replays and settled in tx 0x9e335daa…1501.
const SETTLEMENT = COW_CONTRACTS_BY_CHAIN[100].settlement;
const OWNER = getAddress("0x458cd345b4c05e8df39d0a07220feb4ec19f5e6f");
const LIVE_ORDER: CowOrder = {
  sellToken: getAddress("0xddafbb505ad214d7b80b1f830fccc89b60fb7a83"),
  buyToken: getAddress("0xaf204776c7245bf4147c2612bf6e5972ee483701"),
  receiver: OWNER,
  sellAmount: BigInt("32000000000"),
  buyAmount: BigInt("25560546837969593548561"),
  validTo: 1786009464,
  appData: "0x6d43548de32b5af6c5ea6064a97e247a5737db1264d19fc663d6ec657487a956",
  feeAmount: BigInt(0),
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
};
const LIVE_UID: Hex =
  "0x0ebc355394854ff1026510549fe9cc1edc621ed5bd9bef6acf0bb59f8eb947fc458cd345b4c05e8df39d0a07220feb4ec19f5e6f6a745778";
const LIVE_FULL_APP_DATA =
  '{"appCode":"CoW Swap","environment":"production","metadata":{"orderClass":{"orderClass":"market"},"quote":{"slippageBips":1,"smartSlippage":false}},"version":"1.15.0"}';

describe("order uid", () => {
  it("reproduces a live order's uid from its fields", () => {
    expect(orderUid(100, SETTLEMENT, LIVE_ORDER, OWNER)).toBe(LIVE_UID);
  });

  it("the uid is digest ‖ owner ‖ validTo", () => {
    const parsed = parseOrderUid(LIVE_UID);
    expect(parsed).toEqual({
      digest: orderDigest(100, SETTLEMENT, LIVE_ORDER),
      owner: OWNER,
      validTo: LIVE_ORDER.validTo,
    });
    expect(() => parseOrderUid("0x1234")).toThrow();
  });

  it("binds every field: another chain, owner, amount or kind is another order", () => {
    const uid = orderUid(100, SETTLEMENT, LIVE_ORDER, OWNER);
    expect(orderUid(1, SETTLEMENT, LIVE_ORDER, OWNER)).not.toBe(uid);
    expect(orderUid(100, SETTLEMENT, LIVE_ORDER, LIVE_ORDER.sellToken)).not.toBe(uid);
    expect(orderUid(100, SETTLEMENT, { ...LIVE_ORDER, buyAmount: LIVE_ORDER.buyAmount + BigInt(1) }, OWNER)).not.toBe(uid);
    expect(orderUid(100, SETTLEMENT, { ...LIVE_ORDER, kind: "buy" }, OWNER)).not.toBe(uid);
    // Addresses are checksummed before hashing: casing does not matter.
    expect(
      orderUid(100, SETTLEMENT, { ...LIVE_ORDER, sellToken: LIVE_ORDER.sellToken.toLowerCase() as Hex }, OWNER),
    ).toBe(uid);
  });
});

describe("appData", () => {
  it("the order's appData is keccak256 of the UTF-8 document, as the orderbook stores it", () => {
    expect(appDataHash(LIVE_FULL_APP_DATA)).toBe(LIVE_ORDER.appData);
  });

  it("our document is fixed, minimal and hashed the same way", () => {
    expect(JSON.parse(APP_DATA_DOC)).toEqual({ appCode: "La Caisse", metadata: {}, version: "1.3.0" });
    expect(APP_DATA_HASH).toBe(appDataHash(APP_DATA_DOC));
    expect(APP_DATA_HASH).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("orderFromQuote", () => {
  const quote = { sellAmount: BigInt("99700000000000000000"), feeAmount: BigInt("300000000000000000"), buyAmount: BigInt("111000000000000000000") };

  it("sells the whole input fee-less, at least the enforced minimum, fill-or-kill", () => {
    const o = orderFromQuote({
      sellToken: LIVE_ORDER.sellToken,
      buyToken: LIVE_ORDER.buyToken,
      receiver: OWNER,
      quote,
      buyAmount: applySlippage(quote.buyAmount, 50),
      validTo: 1800000000,
    });
    expect(o.sellAmount).toBe(BigInt("100000000000000000000"));
    expect(o.feeAmount).toBe(BigInt(0));
    expect(o.buyAmount).toBe(BigInt("110445000000000000000"));
    expect(o.kind).toBe("sell");
    expect(o.partiallyFillable).toBe(false);
    expect(o.appData).toBe(APP_DATA_HASH);
    expect(o.sellTokenBalance).toBe("erc20");
    expect(orderFromJson(orderToJson(o))).toEqual(o);
  });

  it("applySlippage rounds down and refuses nonsense", () => {
    expect(applySlippage(BigInt(10_000), 50)).toBe(BigInt(9_950));
    expect(applySlippage(BigInt(3), 1)).toBe(BigInt(2));
    expect(applySlippage(BigInt(10_000), 0)).toBe(BigInt(10_000));
    expect(() => applySlippage(BigInt(1), -1)).toThrow();
    expect(() => applySlippage(BigInt(1), 10_000)).toThrow();
    expect(() => applySlippage(BigInt(1), 1.5)).toThrow();
  });
});

describe("calldata", () => {
  it("setPreSignature(uid, true) matches the live batch's inner call", () => {
    // The second inner call of the GnosisDAO batch in safe-tx.test.ts.
    expect(setPreSignatureData(LIVE_UID, true)).toBe(
      "0xec6cb13f0000000000000000000000000000000000000000000000000000000000000040" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000038" +
        "0ebc355394854ff1026510549fe9cc1edc621ed5bd9bef6acf0bb59f8eb947fc" +
        "458cd345b4c05e8df39d0a07220feb4ec19f5e6f6a7457780000000000000000",
    );
    const d = decodeFunctionData({ abi: GPV2_SETTLEMENT_ABI, data: setPreSignatureData(LIVE_UID, false) });
    expect(d.args).toEqual([LIVE_UID, false]);
  });

  it("approve(VaultRelayer, amount) matches the live batch's first inner call", () => {
    expect(erc20ApproveData(COW_CONTRACTS_BY_CHAIN[100].vaultRelayer, BigInt("32000000000"))).toBe(
      "0x095ea7b3000000000000000000000000c92e8bdf79f0507f65a392b0ab4667716bfe0110" +
        "0000000000000000000000000000000000000000000000000000000773594000",
    );
    const d = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: erc20ApproveData(OWNER, BigInt(7)) });
    expect(d.args).toEqual([OWNER, BigInt(7)]);
  });
});
