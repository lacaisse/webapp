-- Cache the CitizenPay place's on-chain account on every connected
-- Merchant. Used to resolve "address → merchant" for the token explorer
-- and transfer labels without re-listing places on every render.
-- Nullable: CP can issue a place before its wallet is ready, and the
-- next sync overwrites once an address arrives.

ALTER TABLE "Merchant" ADD COLUMN "citizenPayPlaceAccount" TEXT;

CREATE INDEX "Merchant_fundId_citizenPayPlaceAccount_idx"
  ON "Merchant"("fundId", "citizenPayPlaceAccount");
