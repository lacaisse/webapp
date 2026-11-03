// SPDX-License-Identifier: AGPL-3.0-or-later

// Token converters — shared types. Pure: importable from client components,
// server actions and services alike. Module map: services/convert/assets.ts.
//
// A conversion turns one asset a fund account holds into another (EURe →
// BREAD, BREAD → EURe, …). It is made of LEGS, each a single hop with its
// own quote and its own small state machine (a CoW swap, a BREAD mint); a
// CONVERTER is an ordered list of legs (services/convert/registry.ts). The
// ENGINE (engine.ts / progress.ts) walks the legs (walk.ts), turns their
// on-chain steps into Safe proposals, runs their API steps and polls their
// waits — legs never touch Safes, the DB or crons.

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// CAIP-19 asset ids, so a pair reads the same in the registry, on a stored
// row and in a log line: `eip155:100/erc20:0x…` (lowercased address) for an
// ERC-20, `eip155:100/slip44:700` for the chain's native coin.
export type Erc20AssetId = `eip155:${number}/erc20:0x${string}`;
export type NativeAssetId = `eip155:${number}/slip44:${number}`;
export type AssetId = Erc20AssetId | NativeAssetId;

// One call the holder makes. `label` is a short code the UI translates
// ("approve", "presign", "burn", "wrap", "unwrap", "mint").
export type Call = { to: Address; value: bigint; data: Hex; label: string };

export type LegQuote = {
  amountIn: bigint;
  amountOut: bigint; // expected
  minAmountOut: bigint; // what the leg enforces (slippage applied)
  // What the leg costs, in units of its input asset, when it has a price
  // (a swap's network fee, paid inside the price). Absent = free.
  fee?: bigint;
  validUntil: Date;
  data?: unknown; // leg-private, JSON-serialisable (a CoW quote, an order…)
};

export type StepKind = Step["kind"];

// What a leg asks for next. `api`: the server calls an outside service
// (leg.run). `calls`: the holder executes these, as one batch (one Safe
// proposal). `wait`: something external completes, polled (leg.poll).
export type Step =
  | { kind: "api"; label: string }
  | { kind: "calls"; label: string; calls: Call[] }
  | { kind: "wait"; label: string };

// Stored on the conversion row (JSON), hence strings for amounts.
export type StepResult =
  | { kind: "api"; ref: string; data?: unknown }
  | { kind: "calls"; txHash: string | null }
  | { kind: "wait"; amountOut: string; txHash: string | null };

export type PollResult =
  | { status: "pending" }
  | { status: "filled"; result: Extract<StepResult, { kind: "wait" }> }
  | { status: "expired" }
  | { status: "failed"; reason: string };

export type QuoteRequest = {
  chainId: number;
  holder: Address;
  amountIn: bigint;
  slippageBps: number;
  validFor: number; // seconds the quote / order should stay valid
  now: Date;
};

// What a leg sees of its own conversion: its actual input (the previous
// leg's real output), its quote and the results of its steps so far.
export type LegContext = {
  chainId: number;
  holder: Address;
  amountIn: bigint;
  quote: LegQuote;
  results: StepResult[];
  now: Date;
};

// A contract a leg may call and the functions (4-byte selectors, lowercase)
// it may call on it.
export type AllowedContract = { address: Address; selectors: Hex[] };

export type Leg = {
  id: string; // stored on rows: never rename
  from: AssetId;
  to: AssetId;
  // Output equals input and is known up front (a 1:1 mint / burn). The walk
  // folds such a leg's calls into the next leg's first batch.
  exact: boolean;
  // The kinds of its steps, in order — what `next` will ask for. Drives the
  // progress shown to people (steps.ts); `next` stays the source of truth.
  steps: readonly StepKind[];
  // Every contract this leg's calls may target and the functions it may call
  // on it: the engine refuses anything else before it reaches a Safe.
  contracts(chainId: number): AllowedContract[];
  quote(r: QuoteRequest): Promise<LegQuote>;
  // Pure: the next step given the results so far, null once the leg is done.
  next(c: LegContext): Step | null;
  // The leg's actual output once known (exact legs: the input), else null.
  output(c: LegContext): bigint | null;
  run?(c: LegContext): Promise<StepResult>; // an `api` step
  poll?(c: LegContext): Promise<PollResult>; // a `wait` step
};

export type Converter = {
  id: string; // stored on rows: never rename
  legs: Leg[]; // from = legs[0].from, to = legs.at(-1).to
};

// Per-leg state stored on FundConversion.state (JSON).
export type JsonLegQuote = {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  fee?: string;
  validUntil: string; // ISO
  data?: unknown;
};
export type LegState = { quote: JsonLegQuote; results: StepResult[] };
export type ConversionState = { legs: LegState[] };

export function legQuoteToJson(q: LegQuote): JsonLegQuote {
  return {
    amountIn: q.amountIn.toString(),
    amountOut: q.amountOut.toString(),
    minAmountOut: q.minAmountOut.toString(),
    ...(q.fee === undefined ? {} : { fee: q.fee.toString() }),
    validUntil: q.validUntil.toISOString(),
    ...(q.data === undefined ? {} : { data: q.data }),
  };
}

export function legQuoteFromJson(j: JsonLegQuote): LegQuote {
  return {
    amountIn: BigInt(j.amountIn),
    amountOut: BigInt(j.amountOut),
    minAmountOut: BigInt(j.minAmountOut),
    ...(j.fee === undefined ? {} : { fee: BigInt(j.fee) }),
    validUntil: new Date(j.validUntil),
    ...(j.data === undefined ? {} : { data: j.data }),
  };
}

export type ConvertErrorCode =
  | "config" // env / contracts missing for the chain
  | "cow_api" // CoW orderbook HTTP / shape error
  | "rate_limited" // the orderbook throttled order creation (429 twice)
  | "no_pair" // no converter for (from, to), or the fund does not show both
  | "quote_failed" // the outside service gave no usable quote
  | "quote_moved" // fresh minimum below what the user accepted
  | "amount" // zero / malformed / too precise
  | "expired" // the order or quote ran out
  | "fill_mismatch" // the fill reported does not match the chain
  | "funds_moved" // the holder no longer holds a step's input
  | "contract_refused" // a leg produced a call outside its contracts
  | "not_found"
  | "invalid_state"; // e.g. continuing a conversion that is not READY

export class ConvertError extends Error {
  readonly code: ConvertErrorCode;
  constructor(code: ConvertErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConvertError";
    this.code = code;
  }
}

export function isConvertError(e: unknown): e is ConvertError {
  return e instanceof ConvertError;
}
