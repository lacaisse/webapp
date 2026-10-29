// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  hashTypedData,
  keccak256,
  size,
  slice,
  toHex,
  hexToNumber,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { SAFE_ABI } from "@/services/safe/abi";
import { SAFE_CONTRACTS_BY_CHAIN } from "@/services/safe/config";
import {
  SENTINEL_OWNERS,
  ZERO_ADDRESS,
  addOwnerWithThresholdData,
  buildSafeTx,
  changeThresholdData,
  erc20TransferData,
  packSignatures,
  predictSafeAddress,
  randomSaltNonce,
  recoverSafeTxSigner,
  removeOwnerData,
  safeSetupData,
  safeTxHash,
  safeTxTypedData,
  summarizeOwnerDiff,
  swapOwnerData,
} from "@/services/safe/safe-tx";
import { SafeError, type Address, type Hex, type SafeTx } from "@/services/safe/types";

// Offline vectors captured from Gnosis (chain 100) on 2026-10-29.
//
// (1) An executed GnosisDAO Safe tx (swapOwner, nonce 2284) and one of its
//     owner confirmations, as returned by the Safe Transaction Service.
// (2) A Safe 1.4.1 (SafeL2) proxy deployed through the canonical
//     SafeProxyFactory 0x4e1D…ec67: tx 0xbf7dbddf…cbf3 called
//     createProxyWithNonce(singleton, LIVE_INITIALIZER, 0) and its
//     ProxyCreation log reports proxy 0x8AD5…2aA0. PROXY_CREATION_CODE_141 is
//     the factory's proxyCreationCode() read on-chain.
const LIVE_INITIALIZER: Hex =
  ("0x" +
    "b63e800d0000000000000000000000000000000000000000000000000000000000000100000000000000000000000000" +
    "00000000000000000000000000000000000000010000000000000000000000008ecd4ec46d4d2a6b64fe960b3d64e8b9" +
    "4b2234eb0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000" +
    "a581c4a4db7175302464ff3c06380bc3270b403700000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" +
    "000000010000000000000000000000005fc0f90c01f23a0f414406b44bef486d19a7fbcb000000000000000000000000" +
    "00000000000000000000000000000000000000648d0dc49f000000000000000000000000000000000000000000000000" +
    "000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000" +
    "00000000a581c4a4db7175302464ff3c06380bc3270b4037000000000000000000000000000000000000000000000000" +
    "00000000") as Hex;

const PROXY_CREATION_CODE_141: Hex =
  ("0x" +
    "608060405234801561001057600080fd5b506040516101e63803806101e6833981810160405260208110156100335760" +
    "0080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ff" +
    "ffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000" +
    "000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191" +
    "505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff0219169083" +
    "73ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ff" +
    "ffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000" +
    "000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e600081" +
    "14156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a" +
    "82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e2061646472657373207072" +
    "6f7669646564") as Hex;

const SAFE_TX_TYPEHASH = keccak256(
  toHex(
    "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)",
  ),
);
const DOMAIN_SEPARATOR_TYPEHASH = keccak256(
  toHex("EIP712Domain(uint256 chainId,address verifyingContract)"),
);

// Safe.getTransactionHash re-implemented by hand (abi.encode, no viem typed
// data) — the reference the viem-based helper must agree with.
function referenceSafeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        SAFE_TX_TYPEHASH,
        tx.to,
        tx.value,
        keccak256(tx.data),
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        tx.nonce,
      ],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

const GNOSIS_DAO_SAFE: Address = "0x458cD345B4C05e8DF39d0A07220feb4Ec19F5e6f";
const GNOSIS_DAO_TX = buildSafeTx({
  to: GNOSIS_DAO_SAFE,
  data: ("0xe318b52b000000000000000000000000bab04858c4ebbb226dd12b38639e59450820536f" +
    "000000000000000000000000e9eb7da58f6b5ce5b0a6cfd778a2fa726203aad5" +
    "0000000000000000000000001781d4f0c167a68be78ce98c8a6a4ca96db4af0e") as Hex,
  nonce: BigInt(2284),
});
const GNOSIS_DAO_SAFE_TX_HASH: Hex =
  "0xf048faa39045b97362e57d6c12ddb052a19cd4465c41473b3ad981c3e4c85938";
const GNOSIS_DAO_CONFIRMATION = {
  owner: "0x964aE5aB627f1d536d5d5796734B7a44AD6531E3" as Address,
  signature: ("0xb76d7e89211c74fc7339aee7be534345417689f541436ce752a9826a2cd4e998" +
    "2e5b1134881a46d0999df85606f0ed2318701b6c795492e7ccb3effaa55a89361c") as Hex,
};

const SAFE: Address = "0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0x3333333333333333333333333333333333333333";

function sig(byte: string, v = "1b"): Hex {
  return `0x${byte.repeat(64)}${v}` as Hex;
}

describe("safeTxHash", () => {
  it("SafeTx typehash constant matches the Safe contracts", () => {
    expect(SAFE_TX_TYPEHASH).toBe(
      "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8",
    );
  });

  it("matches a live Safe tx hash on Gnosis", () => {
    expect(safeTxHash({ chainId: 100, safeAddress: GNOSIS_DAO_SAFE, tx: GNOSIS_DAO_TX })).toBe(
      GNOSIS_DAO_SAFE_TX_HASH,
    );
  });

  it("agrees with the hand-encoded reference and plain viem hashTypedData", () => {
    const tx = buildSafeTx({
      to: B,
      value: BigInt("1000000000000000000"),
      data: erc20TransferData(C, BigInt(1234500)),
      nonce: BigInt(7),
    });
    const ours = safeTxHash({ chainId: 100, safeAddress: SAFE, tx });
    expect(ours).toBe(referenceSafeTxHash(100, SAFE, tx));
    expect(ours).toBe(hashTypedData(safeTxTypedData({ chainId: 100, safeAddress: SAFE, tx })));
    // Domain binds chain and Safe.
    expect(safeTxHash({ chainId: 1, safeAddress: SAFE, tx })).not.toBe(ours);
    expect(safeTxHash({ chainId: 100, safeAddress: A, tx })).not.toBe(ours);
  });

  it("buildSafeTx zeroes the gas/refund fields and defaults value/data/operation", () => {
    const tx = buildSafeTx({ to: A, nonce: BigInt(3) });
    expect(tx).toEqual({
      to: getAddress(A),
      value: BigInt(0),
      data: "0x",
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: BigInt(3),
    });
  });
});

describe("packSignatures", () => {
  it("orders by owner address ascending, case-insensitively", () => {
    const upper = "0xABCDEF0000000000000000000000000000000000" as Address;
    const packed = packSignatures([
      { owner: C, signature: sig("cc") },
      { owner: upper, signature: sig("ee") },
      { owner: A, signature: sig("aa") },
    ]);
    expect(size(packed)).toBe(65 * 3);
    expect(slice(packed, 0, 65)).toBe(sig("aa"));
    expect(slice(packed, 65, 130)).toBe(sig("cc"));
    expect(slice(packed, 130, 195)).toBe(sig("ee"));
  });

  it("rejects duplicate owners (any casing)", () => {
    const lower = "0xabcdef0000000000000000000000000000000000" as Address;
    const upper = "0xABCDEF0000000000000000000000000000000000" as Address;
    expect(() =>
      packSignatures([
        { owner: lower, signature: sig("aa") },
        { owner: upper, signature: sig("bb") },
      ]),
    ).toThrow(SafeError);
  });

  it("rejects signatures that are not 65 bytes", () => {
    try {
      packSignatures([{ owner: A, signature: "0x1234" }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafeError);
      expect((e as SafeError).code).toBe("invalid_signature");
    }
  });
});

describe("recoverSafeTxSigner", () => {
  const tx = buildSafeTx({ to: B, data: changeThresholdData(BigInt(2)), nonce: BigInt(1) });
  const args = { chainId: 100, safeAddress: SAFE, tx };

  it("recovers a live EIP-712 confirmation from Safe{Wallet}", async () => {
    const owner = await recoverSafeTxSigner({
      chainId: 100,
      safeAddress: GNOSIS_DAO_SAFE,
      tx: GNOSIS_DAO_TX,
      signature: GNOSIS_DAO_CONFIRMATION.signature,
    });
    expect(owner).toBe(GNOSIS_DAO_CONFIRMATION.owner);
  });

  it("round-trips an EIP-712 signature (v 27/28)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signTypedData(safeTxTypedData(args));
    expect([27, 28]).toContain(hexToNumber(slice(signature, 64, 65)));
    await expect(recoverSafeTxSigner({ ...args, signature })).resolves.toBe(account.address);
  });

  it("round-trips an eth_sign signature (v 31/32)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const raw = await account.signMessage({ message: { raw: safeTxHash(args) } });
    const v = hexToNumber(slice(raw, 64, 65));
    const signature = concat([slice(raw, 0, 64), toHex(v + 4, { size: 1 })]);
    await expect(recoverSafeTxSigner({ ...args, signature })).resolves.toBe(account.address);
  });

  it("a signature over another tx recovers a different address", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = { ...args, tx: { ...tx, nonce: BigInt(2) } };
    const signature = await account.signTypedData(safeTxTypedData(other));
    await expect(recoverSafeTxSigner({ ...args, signature })).resolves.not.toBe(
      account.address,
    );
  });

  it("rejects contract / approved-hash signatures and bad lengths", async () => {
    await expect(recoverSafeTxSigner({ ...args, signature: sig("aa", "00") })).rejects.toThrow(
      SafeError,
    );
    await expect(recoverSafeTxSigner({ ...args, signature: sig("aa", "01") })).rejects.toThrow(
      SafeError,
    );
    await expect(recoverSafeTxSigner({ ...args, signature: "0x12" })).rejects.toThrow(SafeError);
  });
});

describe("owner-management calldata", () => {
  const owners = [A, B, C];

  function decode(data: Hex) {
    return decodeFunctionData({ abi: SAFE_ABI, data });
  }

  it("removeOwner uses SENTINEL for the first owner, else the preceding one", () => {
    expect(decode(removeOwnerData(owners, A, BigInt(1))).args).toEqual([
      SENTINEL_OWNERS,
      getAddress(A),
      BigInt(1),
    ]);
    expect(decode(removeOwnerData(owners, C.toLowerCase() as Address, BigInt(2))).args).toEqual([
      getAddress(B),
      getAddress(C),
      BigInt(2),
    ]);
  });

  it("swapOwner uses the same prevOwner rule", () => {
    const D: Address = "0x4444444444444444444444444444444444444444";
    const decoded = decode(swapOwnerData(owners, B, D));
    expect(decoded.functionName).toBe("swapOwner");
    expect(decoded.args).toEqual([getAddress(A), getAddress(B), getAddress(D)]);
    expect(decode(swapOwnerData(owners, A, D)).args?.[0]).toBe(SENTINEL_OWNERS);
  });

  it("throws not_owner for an absent owner", () => {
    const D: Address = "0x4444444444444444444444444444444444444444";
    try {
      removeOwnerData(owners, D, BigInt(1));
      expect.unreachable();
    } catch (e) {
      expect((e as SafeError).code).toBe("not_owner");
    }
    expect(() => swapOwnerData(owners, D, A)).toThrow(SafeError);
  });

  it("encodes addOwnerWithThreshold / changeThreshold", () => {
    expect(decode(addOwnerWithThresholdData(A, BigInt(2)))).toMatchObject({
      functionName: "addOwnerWithThreshold",
      args: [getAddress(A), BigInt(2)],
    });
    expect(decode(changeThresholdData(BigInt(3)))).toMatchObject({
      functionName: "changeThreshold",
      args: [BigInt(3)],
    });
  });

  it("summarizeOwnerDiff ignores casing", () => {
    expect(summarizeOwnerDiff([A, B], [B.toLowerCase() as Address, C])).toEqual({
      added: [getAddress(C)],
      removed: [getAddress(A)],
    });
  });
});

describe("deployment", () => {
  const gnosis = SAFE_CONTRACTS_BY_CHAIN[100];

  it("predictSafeAddress reproduces a live SafeProxyFactory 1.4.1 deployment", () => {
    expect(
      predictSafeAddress({
        proxyFactory: gnosis.proxyFactory,
        singleton: gnosis.singleton,
        initializer: LIVE_INITIALIZER,
        saltNonce: BigInt(0),
        proxyCreationCode: PROXY_CREATION_CODE_141,
      }),
    ).toBe("0x8AD5a865cc1942B1b2b36C186403f89bfF512aA0");
  });

  it("predictSafeAddress follows the factory's CREATE2 derivation", () => {
    const initializer = safeSetupData({
      owners: [A, B],
      threshold: BigInt(2),
      fallbackHandler: gnosis.fallbackHandler,
    });
    const saltNonce = BigInt("123456789");
    const expected = getContractAddress({
      opcode: "CREATE2",
      from: gnosis.proxyFactory,
      salt: keccak256(concat([keccak256(initializer), toHex(saltNonce, { size: 32 })])),
      bytecode: concat([
        PROXY_CREATION_CODE_141,
        encodeAbiParameters([{ type: "address" }], [gnosis.singleton]),
      ]),
    });
    const args = {
      proxyFactory: gnosis.proxyFactory,
      singleton: gnosis.singleton,
      initializer,
      saltNonce,
      proxyCreationCode: PROXY_CREATION_CODE_141,
    };
    expect(predictSafeAddress(args)).toBe(expected);
    expect(predictSafeAddress({ ...args, saltNonce: saltNonce + BigInt(1) })).not.toBe(expected);
  });

  it("safeSetupData encodes setup with no module call and no refund", () => {
    const data = safeSetupData({
      owners: [A, B],
      threshold: BigInt(1),
      fallbackHandler: gnosis.fallbackHandler,
    });
    const decoded = decodeFunctionData({ abi: SAFE_ABI, data });
    expect(decoded.functionName).toBe("setup");
    expect(decoded.args).toEqual([
      [getAddress(A), getAddress(B)],
      BigInt(1),
      ZERO_ADDRESS,
      "0x",
      gnosis.fallbackHandler,
      ZERO_ADDRESS,
      BigInt(0),
      ZERO_ADDRESS,
    ]);
  });

  it("randomSaltNonce yields distinct uint256 values", () => {
    const a = randomSaltNonce();
    const b = randomSaltNonce();
    expect(a).not.toBe(b);
    expect(a >= BigInt(0) && a < BigInt(2) ** BigInt(256)).toBe(true);
  });
});
