-- Cache CP's business id on every connected Merchant. CitizenPay groups
-- places under a business; the treasury-side "disconnect" tears down all
-- places of a business in one call, so we need to find sibling Merchant
-- rows in the same fund locally. Nullable: only populated once the
-- merchant connects on CP and the next places-sync writes both ids.

ALTER TABLE "Merchant" ADD COLUMN "citizenPayBusinessId" TEXT;

CREATE INDEX "Merchant_fundId_citizenPayBusinessId_idx"
  ON "Merchant"("fundId", "citizenPayBusinessId");
