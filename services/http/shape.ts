// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

// Shape checks for the JSON an HTTP service answers (the Safe Transaction
// Service, the CoW orderbook). Each helper returns the value typed or throws
// a ShapeError naming the field; a client runs its parse through `shaped` so
// a ShapeError becomes the client's own error with the request in the
// message, while anything else (a bug, not a bad answer) passes untouched.
// No "server-only": nothing here touches secrets or the network.

export class ShapeError extends Error {}

export function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ShapeError(`${what} is not an object`);
  }
  return v as Record<string, unknown>;
}

export function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) {
    throw new ShapeError(`${what} is not an address`);
  }
  return getAddress(v);
}

export function addrOrNull(v: unknown, what: string): Address | null {
  return v === null || v === undefined || v === "" ? null : addr(v, what);
}

export function hex(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !isHex(v)) throw new ShapeError(`${what} is not hex`);
  return v;
}

export function hexOrNull(v: unknown, what: string): Hex | null {
  return v === null || v === undefined || v === "" ? null : hex(v, what);
}

// Amounts come as decimal strings (token units overflow a double); a bare
// number is taken too.
export function uint(v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new ShapeError(`${what} is not an integer`);
  return BigInt(v);
}

// Counters (nonce, block number): a number, or a digit string the way the
// Safe service writes nonces.
export function int(v: unknown, what: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new ShapeError(`${what} is not an integer`);
  }
  return n;
}

export function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new ShapeError(`${what} is not a string`);
  return v;
}

export function strOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : str(v, what);
}

/** Runs `parse`; a ShapeError is re-thrown as `wrap(e)`, anything else as is. */
export function shaped<T>(parse: () => T, wrap: (e: ShapeError) => Error): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof ShapeError) throw wrap(e);
    throw e;
  }
}
