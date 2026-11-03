// SPDX-License-Identifier: AGPL-3.0-or-later

// Where a conversion stands in its legs, and the chained quote. Pure —
// unit-tested in walk.test.ts. Module map: services/convert/assets.ts.
//
// The walk feeds each leg's actual output into the next leg's input and asks
// each leg for its next step. One rule makes multi-leg conversions cheap on
// a multisig: an `exact` leg (output known up front) whose step is `calls`
// is FOLDED — its calls are held and prepended to the next leg's first
// `calls` step, so BREAD → EURe is burn + wrap + approve + presign in one
// batch. The next leg's `api` step still runs first (the CoW order is posted
// before the batch; pre-sign orders need no balance yet).

import { getAddress } from "viem";

import {
  ConvertError,
  legQuoteFromJson,
  type Address,
  type ConversionState,
  type Converter,
  type LegContext,
  type LegQuote,
  type QuoteRequest,
  type Step,
} from "./types";

export type Position = {
  legIndex: number; // the leg whose step this is
  step: Step;
  // Legs whose state records this step's result: the leg itself and, for a
  // folded `calls` batch, the exact legs folded into it.
  appliesTo: number[];
  amountIn: bigint; // the leg's actual input
};

export type Walk =
  | { done: false; position: Position }
  | { done: true; position: null; amountOut: bigint };

export function legContext(a: {
  chainId: number;
  holder: Address;
  amountIn: bigint;
  state: ConversionState;
  legIndex: number;
  now: Date;
}): LegContext {
  const leg = a.state.legs[a.legIndex];
  if (!leg) throw new ConvertError("invalid_state", `No state for leg ${a.legIndex}`);
  return {
    chainId: a.chainId,
    holder: a.holder,
    amountIn: a.amountIn,
    quote: legQuoteFromJson(leg.quote),
    results: leg.results,
    now: a.now,
  };
}

export function walk(a: {
  converter: Converter;
  chainId: number;
  holder: Address;
  amountIn: bigint;
  state: ConversionState;
  now: Date;
}): Walk {
  const { converter } = a;
  if (a.state.legs.length !== converter.legs.length) {
    throw new ConvertError("invalid_state", "Conversion state does not match its converter");
  }
  let amountIn = a.amountIn;
  const folded: { calls: Step & { kind: "calls" }; legIndex: number }[] = [];
  for (let i = 0; i < converter.legs.length; i++) {
    const leg = converter.legs[i];
    const ctx = legContext({ ...a, amountIn, legIndex: i });
    const step = leg.next(ctx);
    if (step === null) {
      const out = leg.output(ctx);
      if (out === null) {
        throw new ConvertError("invalid_state", `Leg ${leg.id} is done but has no output`);
      }
      amountIn = out;
      continue;
    }
    if (leg.exact && step.kind === "calls" && i + 1 < converter.legs.length) {
      folded.push({ calls: step, legIndex: i });
      // Exact: the next leg's input is this leg's input.
      continue;
    }
    if (step.kind === "calls" && folded.length) {
      return {
        done: false,
        position: {
          legIndex: i,
          step: {
            kind: "calls",
            label: step.label,
            calls: [...folded.flatMap((f) => f.calls.calls), ...step.calls],
          },
          appliesTo: [...folded.map((f) => f.legIndex), i],
          amountIn,
        },
      };
    }
    return { done: false, position: { legIndex: i, step, appliesTo: [i], amountIn } };
  }
  if (folded.length) {
    // Only reachable with a converter ending in an exact leg whose calls were
    // folded — the loop never folds the last leg, so this is a guard.
    throw new ConvertError("invalid_state", "Folded calls with no batch to join");
  }
  return { done: true, position: null, amountOut: amountIn };
}

/** Every address a converter's legs may call on a chain (checksummed). */
export function converterContracts(converter: Converter, chainId: number): Set<string> {
  return new Set(converter.legs.flatMap((l) => l.contracts(chainId)).map((c) => getAddress(c)));
}

export type ChainQuote = {
  legs: LegQuote[];
  expectedOut: bigint;
  // The minimum the conversion as a whole enforces: an exact leg passes its
  // input through, a swap leg's quote carries the slippage.
  minOut: bigint;
  // What the conversion costs, in units of ITS input asset: the fees of the
  // legs reached only through exact (1:1) legs, so a fee quoted in WXDAI on
  // a BREAD → EURe conversion counts as BREAD. Null when a fee sits behind a
  // swap (another unit) — not the case for the converters registered today.
  fee: bigint | null;
  validUntil: Date;
};

/**
 * Quote every leg in turn, each on the expected output of the previous one.
 * With the converters registered today (one swap leg, exact legs around it)
 * the overall minimum is exact: a swap's minimum passes through exact legs
 * unchanged. A second swap leg would need its own minimum quoted on the
 * first's minimum — add that when such a converter exists.
 */
export async function quoteChain(converter: Converter, req: QuoteRequest): Promise<ChainQuote> {
  const legs: LegQuote[] = [];
  let amountIn = req.amountIn;
  let minOut = req.amountIn;
  let fee: bigint | null = BigInt(0);
  let inputUnits = true; // still 1:1 with the conversion's input asset
  let validUntil: Date | null = null;
  for (const leg of converter.legs) {
    const q = await leg.quote({ ...req, amountIn });
    legs.push(q);
    if (q.fee !== undefined && q.fee > BigInt(0)) {
      fee = inputUnits && fee !== null ? fee + q.fee : null;
    }
    if (!leg.exact) inputUnits = false;
    amountIn = q.amountOut;
    minOut = leg.exact ? minOut : q.minAmountOut;
    validUntil = validUntil && validUntil < q.validUntil ? validUntil : q.validUntil;
  }
  if (!validUntil) throw new ConvertError("invalid_state", "Converter has no legs");
  return { legs, expectedOut: amountIn, minOut, fee, validUntil };
}
