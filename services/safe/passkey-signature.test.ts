// SPDX-License-Identifier: AGPL-3.0-or-later
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { concat, hexToBytes, keccak256, sha256, size, slice, stringToBytes, toHex } from "viem";
import { describe, expect, it } from "vitest";

import {
  CONTRACT_SIGNATURE_STATIC_LENGTH,
  P256_N,
  authenticatorFlags,
  base64UrlDecode,
  base64UrlEncode,
  challengeForHash,
  clientDataFieldsFor,
  clientDataJsonFor,
  contractSignature,
  decodeWebAuthnSignature,
  derSignatureToRs,
  encodeWebAuthnSignature,
  isContractSignature,
  parseContractSignature,
  passkeyContractSignature,
  rpIdHashOf,
  rsToDerSignature,
  webauthnSigningMessage,
} from "@/services/safe/passkey-signature";
import type { Address, Hex } from "@/services/safe/types";

// Known-answer vector for the Safe passkey module v0.2.1 signature format.
// Produced 2026-11-02 from a deterministic P-256 key (scalar keccak256("la-
// caisse safe passkey test vector"), never used anywhere else), rpID
// "localhost", flags UP|UV, counter 7, and checked on Gnosis by eth_call:
// SafeWebAuthnSignerFactory 0x1d31…1195 `isValidSignatureForSigner(
// SAFE_TX_HASH, SIGNATURE, X, Y, VERIFIERS)` answered 0x1626ba7e at block
// 49068533, and 0x00000000 for another message. The factory also derived
// SIGNER for (X, Y, VERIFIERS).
const X = "0xf84ffcc118bbcbb31a3305e4b43e7a46fafcab9133a81b15921093c6babc0de6" as const;
const Y = "0xd5fbe0f64b86af9aa6851431be9a227c79fc7b69d2f98bf9ce60c0f970c73a8e" as const;
const SIGNER: Address = "0x9a1B374DA6e408Ad37A89bd4F1B7011623F5a947";
const VERIFIERS = (BigInt(0x0100) << BigInt(160)) | BigInt("0xc2b78104907F722DABAc4C69f826a522B2754De4");
const SAFE_TX_HASH: Hex = "0xda2e60aa409d18af977b213dcf0b48945a1a60b69b58ab3a8647f1e7927284d6";
const CHALLENGE = "2i5gqkCdGK-XeyE9zwtIlFoaYLabWKs6hkfx55JyhNY";
const AUTHENTICATOR_DATA: Hex =
  "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000007";
const CLIENT_DATA_FIELDS = '"origin":"http://caisse-test.localhost:3031","crossOrigin":false';
const CLIENT_DATA_JSON =
  '{"type":"webauthn.get","challenge":"2i5gqkCdGK-XeyE9zwtIlFoaYLabWKs6hkfx55JyhNY","origin":"http://caisse-test.localhost:3031","crossOrigin":false}';
const R = BigInt("0x6782a1afe497d7769140c2f003d95034148665b85f2df857d072334ec6a4d845");
const S = BigInt("0x18e2ef13af12706a32dc858d47c0d7a691cd89a01b679d951c3bca012d38410f");
const DER: Hex =
  "0x304402206782a1afe497d7769140c2f003d95034148665b85f2df857d072334ec6a4d845022018e2ef13af12706a32dc858d47c0d7a691cd89a01b679d951c3bca012d38410f";
const SIGNATURE: Hex =
  "0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e06782a1afe497d7769140c2f003d95034148665b85f2df857d072334ec6a4d84518e2ef13af12706a32dc858d47c0d7a691cd89a01b679d951c3bca012d38410f000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d976305000000070000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040226f726967696e223a22687474703a2f2f6361697373652d746573742e6c6f63616c686f73743a33303331222c2263726f73734f726967696e223a66616c7365";

const vector = { authenticatorData: AUTHENTICATOR_DATA, clientDataFields: CLIENT_DATA_FIELDS, r: R, s: S };

describe("Safe passkey module signature", () => {
  it("encodes abi.encode(bytes, string, uint256, uint256) exactly as the contract accepted it", () => {
    expect(encodeWebAuthnSignature(vector)).toBe(SIGNATURE);
    // Head: offsets 0x80 (authenticatorData) and 0x80 + 32 + ceil32(37) = 0xe0.
    expect(BigInt(slice(SIGNATURE, 0, 32))).toBe(BigInt(0x80));
    expect(BigInt(slice(SIGNATURE, 32, 64))).toBe(BigInt(0xe0));
    expect(BigInt(slice(SIGNATURE, 64, 96))).toBe(R);
    expect(BigInt(slice(SIGNATURE, 96, 128))).toBe(S);
    // Canonical length: 4 head words + (32 + ceil32(37)) + (32 + ceil32(64)).
    expect(size(SIGNATURE)).toBe(128 + 96 + 96);
  });

  it("decodes back to the same parts", () => {
    expect(decodeWebAuthnSignature(SIGNATURE)).toEqual(vector);
  });

  it("challenge = base64url(safeTxHash) without padding, 43 chars", () => {
    expect(challengeForHash(SAFE_TX_HASH)).toBe(CHALLENGE);
    expect(CHALLENGE).toHaveLength(43);
    expect(toHex(base64UrlDecode(CHALLENGE))).toBe(SAFE_TX_HASH);
    expect(base64UrlEncode(hexToBytes(SAFE_TX_HASH))).toBe(CHALLENGE);
    expect(() => challengeForHash("0x1234")).toThrow(/32 bytes/);
  });

  it("clientDataFields is what follows the challenge, and the challenge must match", () => {
    expect(clientDataFieldsFor(CLIENT_DATA_JSON, CHALLENGE)).toBe(CLIENT_DATA_FIELDS);
    expect(clientDataJsonFor(CHALLENGE, CLIENT_DATA_FIELDS)).toBe(CLIENT_DATA_JSON);
    expect(() => clientDataFieldsFor(CLIENT_DATA_JSON, "A".repeat(43))).toThrow(/does not match/);
    // A browser that reordered the fields can't be rebuilt by the contract.
    const reordered = `{"challenge":"${CHALLENGE}","type":"webauthn.get","origin":"x"}`;
    expect(() => clientDataFieldsFor(reordered, CHALLENGE)).toThrow(/layout/);
    // webauthn.create is a registration, never a signature.
    expect(() =>
      clientDataFieldsFor(`{"type":"webauthn.create","challenge":"${CHALLENGE}","origin":"x"}`, CHALLENGE),
    ).toThrow(/layout/);
  });

  it("the P-256 key signs sha256(authenticatorData ‖ sha256(clientDataJSON))", () => {
    const message = webauthnSigningMessage(AUTHENTICATOR_DATA, CLIENT_DATA_JSON);
    expect(message).toBe(concat([AUTHENTICATOR_DATA, sha256(stringToBytes(CLIENT_DATA_JSON))]));
    const pub = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(hexToBytes(X)).toString("base64url"),
        y: Buffer.from(hexToBytes(Y)).toString("base64url"),
      },
      format: "jwk",
    });
    const ok = nodeVerify("sha256", Buffer.from(hexToBytes(message)), { key: pub, dsaEncoding: "der" }, Buffer.from(hexToBytes(DER)));
    expect(ok).toBe(true);
    // And not over another message.
    const other = webauthnSigningMessage(AUTHENTICATOR_DATA, clientDataJsonFor("B".repeat(43), CLIENT_DATA_FIELDS));
    expect(nodeVerify("sha256", Buffer.from(hexToBytes(other)), { key: pub, dsaEncoding: "der" }, Buffer.from(hexToBytes(DER)))).toBe(false);
  });

  it("parses the authenticator's DER signature into (r, s), normalising to low-s", () => {
    expect(derSignatureToRs(hexToBytes(DER))).toEqual({ r: R, s: S });
    // High-s form of the same signature → folded back to S.
    const highS = rsToDerSignature(R, P256_N - S);
    expect(derSignatureToRs(highS)).toEqual({ r: R, s: S });
    expect(toHex(rsToDerSignature(R, S))).toBe(DER);
    // A leading 0x00 is added when the top bit is set.
    const topBit = BigInt("0x8" + "0".repeat(63));
    const der = rsToDerSignature(topBit, S);
    expect(der[3]).toBe(33);
    expect(derSignatureToRs(der)).toEqual({ r: topBit, s: S });
    expect(() => derSignatureToRs(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow(/DER/);
    expect(() => derSignatureToRs(hexToBytes(DER).slice(0, 40))).toThrow(/DER/);
  });

  it("reads the flags byte and the rpIdHash", () => {
    expect(authenticatorFlags(AUTHENTICATOR_DATA)).toEqual({
      userPresent: true,
      userVerified: true,
      backupEligible: false,
      backupState: false,
    });
    expect(rpIdHashOf(AUTHENTICATOR_DATA)).toBe(sha256(stringToBytes("localhost")));
    const backedUp = concat([slice(AUTHENTICATOR_DATA, 0, 32), "0x1d", slice(AUTHENTICATOR_DATA, 33)]);
    expect(authenticatorFlags(backedUp)).toMatchObject({ backupEligible: true, backupState: true });
    expect(() => authenticatorFlags("0x1234")).toThrow(/short/);
  });

  it("the verifiers word packs the precompile above the fallback", () => {
    expect(toHex(VERIFIERS, { size: 22 })).toBe("0x0100c2b78104907f722dabac4c69f826a522b2754de4");
    expect(SIGNER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("Safe contract signatures", () => {
  const OWNER: Address = "0x9a1B374DA6e408Ad37A89bd4F1B7011623F5a947";

  it("wraps a dynamic part as a standalone contract signature (v 0, r owner, s 65)", () => {
    const sig = contractSignature(OWNER, "0xdeadbeef");
    expect(size(sig)).toBe(CONTRACT_SIGNATURE_STATIC_LENGTH + 32 + 4);
    expect(slice(sig, 0, 32)).toBe(`0x${"0".repeat(24)}${OWNER.slice(2).toLowerCase()}`);
    expect(BigInt(slice(sig, 32, 64))).toBe(BigInt(65));
    expect(slice(sig, 64, 65)).toBe("0x00");
    expect(BigInt(slice(sig, 65, 97))).toBe(BigInt(4));
    expect(slice(sig, 97)).toBe("0xdeadbeef");
    expect(parseContractSignature(sig)).toEqual({ owner: OWNER, dynamicPart: "0xdeadbeef" });
    expect(isContractSignature(sig)).toBe(true);
  });

  it("the passkey wrapper carries the module signature", () => {
    const sig = passkeyContractSignature(SIGNER, vector);
    expect(parseContractSignature(sig)).toEqual({ owner: SIGNER, dynamicPart: SIGNATURE });
  });

  it("rejects anything that is not a strict standalone contract signature", () => {
    const ecdsa = `0x${"11".repeat(64)}1b` as Hex;
    expect(parseContractSignature(ecdsa)).toBeNull();
    expect(isContractSignature(ecdsa)).toBe(false);
    const good = contractSignature(OWNER, "0xdeadbeef");
    // wrong s offset
    const badS = concat([slice(good, 0, 32), toHex(BigInt(66), { size: 32 }), slice(good, 64)]);
    expect(parseContractSignature(badS)).toBeNull();
    // length prefix larger than the data
    const badLen = concat([slice(good, 0, 65), toHex(BigInt(5), { size: 32 }), "0xdeadbeef"]);
    expect(parseContractSignature(badLen)).toBeNull();
    // trailing garbage
    expect(parseContractSignature(concat([good, "0x00"]))).toBeNull();
    // r with high bytes set is not an address
    const badR = concat([keccak256("0x01"), slice(good, 32)]);
    expect(parseContractSignature(badR)).toBeNull();
    expect(parseContractSignature("0x00")).toBeNull();
  });
});
