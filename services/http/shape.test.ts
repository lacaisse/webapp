// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  ShapeError,
  addr,
  addrOrNull,
  hex,
  hexOrNull,
  int,
  obj,
  shaped,
  str,
  strOrNull,
  uint,
} from "./shape";

const LOWER = "0x8ad5a865cc1942b1b2b36c186403f89bff512aa0";
const CHECKSUMMED = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";

describe("obj", () => {
  it("accepts a plain object", () => {
    expect(obj({ a: 1 }, "x")).toEqual({ a: 1 });
  });

  it("refuses null, arrays and scalars", () => {
    expect(() => obj(null, "x")).toThrow(ShapeError);
    expect(() => obj([], "x")).toThrow(ShapeError);
    expect(() => obj("s", "x")).toThrow("x is not an object");
  });
});

describe("addr / addrOrNull", () => {
  it("checksums any case", () => {
    expect(addr(LOWER, "x")).toBe(CHECKSUMMED);
    expect(addr(CHECKSUMMED, "x")).toBe(CHECKSUMMED);
  });

  it("refuses anything that is not an address", () => {
    expect(() => addr("0x1234", "x")).toThrow("x is not an address");
    expect(() => addr(42, "x")).toThrow(ShapeError);
    expect(() => addr(null, "x")).toThrow(ShapeError);
  });

  it("OrNull takes null, undefined and the empty string as null", () => {
    expect(addrOrNull(null, "x")).toBeNull();
    expect(addrOrNull(undefined, "x")).toBeNull();
    expect(addrOrNull("", "x")).toBeNull();
    expect(addrOrNull(LOWER, "x")).toBe(CHECKSUMMED);
    expect(() => addrOrNull("nope", "x")).toThrow(ShapeError);
  });
});

describe("hex / hexOrNull", () => {
  it("accepts 0x-prefixed hex as is", () => {
    expect(hex("0x", "x")).toBe("0x");
    expect(hex("0xAbCd", "x")).toBe("0xAbCd");
  });

  it("refuses bare or odd strings and non-strings", () => {
    expect(() => hex("abcd", "x")).toThrow("x is not hex");
    expect(() => hex("0xzz", "x")).toThrow(ShapeError);
    expect(() => hex(1, "x")).toThrow(ShapeError);
  });

  it("OrNull takes null, undefined and the empty string as null", () => {
    expect(hexOrNull(null, "x")).toBeNull();
    expect(hexOrNull(undefined, "x")).toBeNull();
    expect(hexOrNull("", "x")).toBeNull();
    expect(hexOrNull("0x12", "x")).toBe("0x12");
    expect(() => hexOrNull("12", "x")).toThrow(ShapeError);
  });
});

describe("uint", () => {
  it("reads a number or a digit string as a bigint", () => {
    expect(uint(0, "x")).toBe(BigInt(0));
    expect(uint(42, "x")).toBe(BigInt(42));
    expect(uint("500000000000000000000000", "x")).toBe(BigInt("500000000000000000000000"));
  });

  it("refuses negatives, fractions, signs and non-digits", () => {
    expect(() => uint(-1, "x")).toThrow("x is not an integer");
    expect(() => uint(1.5, "x")).toThrow(ShapeError);
    expect(() => uint("-1", "x")).toThrow(ShapeError);
    expect(() => uint("1e3", "x")).toThrow(ShapeError);
    expect(() => uint("", "x")).toThrow(ShapeError);
    expect(() => uint(null, "x")).toThrow(ShapeError);
  });
});

describe("int", () => {
  it("reads a number or a digit string as a safe integer", () => {
    expect(int(7, "x")).toBe(7);
    expect(int("12", "x")).toBe(12);
    expect(int("0", "x")).toBe(0);
  });

  it("refuses fractions, unsafe values and non-digit strings", () => {
    expect(() => int(1.5, "x")).toThrow("x is not an integer");
    expect(() => int(Number.MAX_SAFE_INTEGER + 1, "x")).toThrow(ShapeError);
    expect(() => int("99999999999999999999", "x")).toThrow(ShapeError);
    expect(() => int("x", "x")).toThrow(ShapeError);
    expect(() => int("", "x")).toThrow(ShapeError);
    expect(() => int(null, "x")).toThrow(ShapeError);
  });
});

describe("str / strOrNull", () => {
  it("accepts a string, the empty one included", () => {
    expect(str("", "x")).toBe("");
    expect(str("v", "x")).toBe("v");
  });

  it("refuses non-strings", () => {
    expect(() => str(1, "x")).toThrow("x is not a string");
    expect(() => str(null, "x")).toThrow(ShapeError);
  });

  it("OrNull takes null and undefined as null, keeps the empty string", () => {
    expect(strOrNull(null, "x")).toBeNull();
    expect(strOrNull(undefined, "x")).toBeNull();
    expect(strOrNull("", "x")).toBe("");
    expect(() => strOrNull(1, "x")).toThrow(ShapeError);
  });
});

describe("shaped", () => {
  class Wrapped extends Error {}
  const wrap = (e: ShapeError) => new Wrapped(`wrapped: ${e.message}`);

  it("returns what parse returns", () => {
    expect(shaped(() => 1, wrap)).toBe(1);
  });

  it("wraps a ShapeError only", () => {
    expect(() => shaped(() => str(1, "x"), wrap)).toThrow(Wrapped);
    expect(() => shaped(() => str(1, "x"), wrap)).toThrow("wrapped: x is not a string");
    const other = new TypeError("bug");
    expect(() =>
      shaped(() => {
        throw other;
      }, wrap),
    ).toThrow(other);
  });
});
