-- Custom display tokens: besides the built-in xDAI / EURe toggles, a fund can
-- register any ERC-20 on its token chain to show on its Accounts pages
-- (balances on named accounts and Safes, Safe history and transfers) —
-- Settings → Token → Custom tokens. Symbol / name / decimals are read from the
-- contract at registration; the address is stored EIP-55 checksummed.

-- CreateTable
CREATE TABLE "FundDisplayToken" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundDisplayToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundDisplayToken_fundId_idx" ON "FundDisplayToken"("fundId");

-- CreateIndex
CREATE UNIQUE INDEX "FundDisplayToken_fundId_address_key" ON "FundDisplayToken"("fundId", "address");

-- AddForeignKey
ALTER TABLE "FundDisplayToken" ADD CONSTRAINT "FundDisplayToken_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
