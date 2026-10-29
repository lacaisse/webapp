// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// publishAccountName against the in-process mock CitizenPay client (no
// CITIZENPAY_API_BASE_URL). The database and `after()` are faked.
vi.mock("server-only", () => ({}));

const prisma = vi.hoisted(() => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { publishAccountName, scheduleAccountNamePublish } from "./publish-name";

const connected = {
  id: "fund-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
};
const unconnected = { id: "fund-2", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };
const account = { serial: "ACCT-5C0DBDFA-3", name: "Cagnotte" };

type MockProto = {
  setCardHolderName: (serial: string, name: string | null) => Promise<void>;
};
let setName: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The mock client is a fresh instance per getCitizenPayClient call; spy on
  // the shared prototype so every instance is observed.
  const proto = Object.getPrototypeOf(getCitizenPayClient(connected)) as MockProto;
  setName = vi.spyOn(proto, "setCardHolderName");
  afterCallbacks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("publishAccountName", () => {
  it("publishes the account's name under its serial", async () => {
    expect(await publishAccountName(connected, account)).toBe("ok");
    expect(setName).toHaveBeenCalledWith("ACCT-5C0DBDFA-3", "Cagnotte");
    expect(warn).not.toHaveBeenCalled();
  });

  it("trims the name and sends null for a blank one", async () => {
    await publishAccountName(connected, { serial: "ACCT-1", name: "  Cagnotte " });
    expect(setName).toHaveBeenLastCalledWith("ACCT-1", "Cagnotte");
    await publishAccountName(connected, { serial: "ACCT-1", name: "   " });
    expect(setName).toHaveBeenLastCalledWith("ACCT-1", null);
  });

  it("skips a fund not connected to CitizenPay", async () => {
    expect(await publishAccountName(unconnected, account)).toBe("skipped");
    expect(setName).not.toHaveBeenCalled();
  });

  it("swallows a client error and logs only the status, once", async () => {
    setName.mockRejectedValue(
      new CitizenPayApiError("bad serial ACCT-5C0DBDFA-3 Cagnotte", 400, {
        error: "Cagnotte",
      }),
    );
    expect(await publishAccountName(connected, account)).toBe("400");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].map(String).join(" ");
    expect(line).toContain("account-name publish failed");
    expect(line).toContain("400");
    expect(line).not.toContain("Cagnotte");
    expect(line).not.toContain("ACCT-");
  });

  it("classifies an unreachable CP as a network failure", async () => {
    setName.mockRejectedValue(new TypeError("fetch failed"));
    expect(await publishAccountName(connected, account)).toBe("network");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleAccountNamePublish", () => {
  it("defers the publish with after()", async () => {
    scheduleAccountNamePublish(connected, account);
    expect(setName).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(setName).toHaveBeenCalledWith("ACCT-5C0DBDFA-3", "Cagnotte");
  });

  it("schedules nothing for an unconnected fund", () => {
    scheduleAccountNamePublish(unconnected, account);
    expect(afterCallbacks).toHaveLength(0);
  });
});
