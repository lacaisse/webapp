// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, alchemyRpc: vi.fn() };
});

import { alchemyRpc } from "./client";
import {
  decodeBlockCursor,
  encodeBlockCursor,
  listTransfersForAccount,
  type AlchemyTransfer,
} from "./transfers";

const rpc = vi.mocked(alchemyRpc);

const ME = "0x1111111111111111111111111111111111111111";
const SHOP = "0x2222222222222222222222222222222222222222";
const BANK = "0x3333333333333333333333333333333333333333";

type Row = { block: number; log: number; from: string; to: string };

/**
 * A fake `alchemy_getAssetTransfers` over a fixed dataset with Alchemy's
 * semantics: one of fromAddress/toAddress, inclusive toBlock, desc order,
 * maxCount, and a pageKey whenever more rows remain in the range.
 */
function fakeAlchemy(rows: Row[]) {
  const asTransfer = (r: Row) => ({
    uniqueId: `0x${r.block.toString(16)}${r.log}:log:${r.log}`,
    blockNum: `0x${r.block.toString(16)}`,
    hash: `0x${r.block.toString(16)}${r.log}`,
    from: r.from,
    to: r.to,
    value: 1,
    rawContract: { value: "0x1" },
    metadata: {},
  });
  rpc.mockImplementation(async (_net, method, params) => {
    if (method === "eth_getBlockByNumber") {
      return { timestamp: (params as string[])[0] };
    }
    const p = (params as Array<Record<string, unknown>>)[0]!;
    expect(p.pageKey).toBeUndefined();
    const to =
      p.toBlock === "latest" ? Infinity : Number(BigInt(p.toBlock as string));
    const max = Number(BigInt(p.maxCount as string));
    const matching = rows
      .filter((r) =>
        p.fromAddress ? r.from === p.fromAddress : r.to === p.toAddress,
      )
      .filter((r) => r.block <= to)
      .sort((a, b) => b.block - a.block || b.log - a.log);
    return {
      transfers: matching.slice(0, max).map(asTransfer),
      ...(matching.length > max ? { pageKey: "more" } : {}),
    };
  });
}

async function walk(pageSize: number, firstCursor: string | null = null) {
  const pages: AlchemyTransfer[][] = [];
  let cursor: string | null = firstCursor;
  for (let i = 0; i < 100; i++) {
    const res: Awaited<ReturnType<typeof listTransfersForAccount>> =
      await listTransfersForAccount({
        chainId: 100,
        contractAddress: "0xtoken",
        account: ME,
        pageSize,
        cursor,
      });
    pages.push(res.transfers);
    cursor = res.nextPageKey;
    if (!cursor) return pages;
  }
  throw new Error("pagination did not terminate");
}

const key = (t: AlchemyTransfer) => [
  Number(BigInt(t.blockNum)),
  Number(t.uniqueId.split(":log:")[1]),
];

function expectOrderedUnion(pages: AlchemyTransfer[][], rows: Row[]) {
  const all = pages.flat();
  // Strictly descending by (block, log): implies no duplicates.
  for (let i = 1; i < all.length; i++) {
    const [pb, pl] = key(all[i - 1]!);
    const [b, l] = key(all[i]!);
    expect(pb! > b! || (pb === b && pl! > l!)).toBe(true);
  }
  // No loss: every distinct row appears exactly once.
  const expected = new Set(rows.map((r) => `${r.block}:${r.log}`));
  expect(new Set(all.map((t) => key(t).join(":")))).toEqual(expected);
  expect(all).toHaveLength(expected.size);
}

beforeEach(() => {
  rpc.mockReset();
});

describe("block cursor", () => {
  it("round-trips the toBlock", () => {
    const c = encodeBlockCursor(BigInt(0x2b5f3a));
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, URL-safe
    expect(decodeBlockCursor(c)).toBe("0x2b5f3a");
  });
  it("treats anything else, including the old two-pageKey scheme, as page 1", () => {
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(decodeBlockCursor(null)).toBeNull();
    expect(decodeBlockCursor("!!!not-base64")).toBeNull();
    expect(decodeBlockCursor(enc({ b: 12 }))).toBeNull();
    expect(decodeBlockCursor(enc({ b: "latest" }))).toBeNull();
    expect(decodeBlockCursor(enc({ b: "0xzz" }))).toBeNull();
    expect(decodeBlockCursor(enc(["0x1"]))).toBeNull();
    expect(decodeBlockCursor(enc({ f: "old", t: "scheme" }))).toBeNull();
  });
});

describe("listTransfersForAccount", () => {
  it("keeps a busy out-stream and a quiet in-stream ordered across pages", async () => {
    const rows: Row[] = [];
    for (let b = 200; b > 100; b -= 2)
      rows.push({ block: b, log: 1, from: ME, to: SHOP });
    for (const b of [199, 150, 40, 5])
      rows.push({ block: b, log: 3, from: BANK, to: ME });
    fakeAlchemy(rows);

    const pages = await walk(10);
    expect(pages.length).toBeGreaterThan(2);
    expectOrderedUnion(pages, rows);
    // The quiet stream's old rows must not jump ahead onto page 1.
    expect(pages[0]!.some((t) => Number(BigInt(t.blockNum)) < 100)).toBe(
      false,
    );
  });

  it("holds back rows sharing the cutoff block and dedupes self-transfers", async () => {
    const rows: Row[] = [
      // Several rows in one block straddling the page boundary.
      ...[9, 8, 7].map((log) => ({ block: 50, log, from: ME, to: SHOP })),
      ...[60, 55, 45, 30].map((block) => ({ block, log: 0, from: ME, to: SHOP })),
      { block: 52, log: 2, from: ME, to: ME }, // self: in both streams
      { block: 50, log: 1, from: BANK, to: ME },
      { block: 10, log: 0, from: BANK, to: ME },
    ];
    fakeAlchemy(rows);
    expectOrderedUnion(await walk(4), rows);
  });

  it("orders rows in the same block by log index", async () => {
    const rows: Row[] = [
      { block: 7, log: 2, from: ME, to: SHOP },
      { block: 7, log: 11, from: BANK, to: ME },
      { block: 7, log: 5, from: ME, to: SHOP },
    ];
    fakeAlchemy(rows);
    const [page] = await walk(25);
    expect(page!.map((t) => key(t)[1])).toEqual([11, 5, 2]);
  });

  it("terminates when a full page sits inside one block", async () => {
    const rows: Row[] = [
      ...Array.from({ length: 8 }, (_, log) => ({
        block: 20,
        log,
        from: ME,
        to: SHOP,
      })),
      { block: 3, log: 0, from: BANK, to: ME },
    ];
    fakeAlchemy(rows);
    const all = (await walk(5)).flat();
    // Accepted loss: only the first pageSize rows of block 20 are shown.
    expect(all.map((t) => key(t).join(":"))).toEqual([
      "20:7",
      "20:6",
      "20:5",
      "20:4",
      "20:3",
      "3:0",
    ]);
  });

  it("restarts from the first page on a malformed cursor", async () => {
    const rows: Row[] = [{ block: 9, log: 0, from: ME, to: SHOP }];
    fakeAlchemy(rows);
    const pages = await walk(25, "garbage");
    expectOrderedUnion(pages, rows);
  });
});

describe("listTransfersForAccount — assets", () => {
  const EURE = "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430";

  function captureParams(transfers: unknown[]) {
    const seen: Array<Record<string, unknown>> = [];
    rpc.mockImplementation(async (_net, method, params) => {
      if (method === "eth_getBlockByNumber") return { timestamp: "0x1" };
      const p = (params as Array<Record<string, unknown>>)[0]!;
      seen.push(p);
      // Serve every row on the out-stream only, so nothing is deduped away.
      return { transfers: p.fromAddress ? transfers : [] };
    });
    return seen;
  }

  it("keeps the single-contract request shape for existing callers", async () => {
    const seen = captureParams([]);
    await listTransfersForAccount({
      chainId: 100,
      contractAddress: "0xtoken",
      account: ME,
      pageSize: 10,
    });
    expect(seen).toHaveLength(2);
    for (const p of seen) {
      expect(p.contractAddresses).toEqual(["0xtoken"]);
      expect(p.category).toEqual(["erc20"]);
    }
  });

  it("queries several contracts plus native transfers", async () => {
    const seen = captureParams([]);
    await listTransfersForAccount({
      chainId: 100,
      contractAddress: "0xignored",
      contractAddresses: ["0xtoken", EURE],
      includeNative: true,
      account: ME,
      pageSize: 10,
    });
    expect(seen).toHaveLength(2);
    for (const p of seen) {
      expect(p.contractAddresses).toEqual(["0xtoken", EURE]);
      expect(p.category).toEqual(["erc20", "external"]);
    }
  });

  it("asks for native transfers alone without a contract filter", async () => {
    const seen = captureParams([]);
    await listTransfersForAccount({
      chainId: 100,
      contractAddresses: [],
      includeNative: true,
      account: ME,
      pageSize: 10,
    });
    expect(seen[0]!.category).toEqual(["external"]);
    expect(seen[0]).not.toHaveProperty("contractAddresses");
  });

  it("returns an empty page without calling Alchemy when nothing is asked", async () => {
    const res = await listTransfersForAccount({
      chainId: 100,
      contractAddresses: [],
      account: ME,
      pageSize: 10,
    });
    expect(res).toEqual({ transfers: [], nextPageKey: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("exposes contract, asset symbol and decimals per transfer", async () => {
    captureParams([
      {
        uniqueId: "0xa:log:2",
        blockNum: "0x10",
        hash: "0xa",
        from: ME,
        to: SHOP,
        value: 1.5,
        asset: "EURe",
        category: "erc20",
        rawContract: { value: "0x14d1120d7b160000", address: EURE, decimal: "0x12" },
        metadata: {},
      },
      {
        uniqueId: "0xb:external",
        blockNum: "0xf",
        hash: "0xb",
        from: ME,
        to: BANK,
        value: 0.1,
        asset: "XDAI",
        category: "external",
        rawContract: { value: "0x16345785d8a0000", address: null, decimal: "0x12" },
        metadata: {},
      },
      {
        uniqueId: "0xc:log:0",
        blockNum: "0xe",
        hash: "0xc",
        from: ME,
        to: SHOP,
        value: 1,
        category: "erc20",
        rawContract: { value: "0x1", address: "0xTOKEN" },
        metadata: {},
      },
    ]);
    const { transfers } = await listTransfersForAccount({
      chainId: 100,
      contractAddresses: ["0xtoken", EURE],
      includeNative: true,
      account: ME,
      pageSize: 10,
    });
    expect(
      transfers.map((t) => [t.contractAddress, t.asset, t.decimals]),
    ).toEqual([
      [EURE.toLowerCase(), "EURe", 18],
      [null, "XDAI", 18],
      ["0xtoken", null, null],
    ]);
  });
});
