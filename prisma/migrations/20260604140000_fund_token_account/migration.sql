-- Named, fund-owned smart accounts: counterfactual Safe addresses derived from
-- the fund's minter EOA + a per-fund-unique salt nonce (salt 0 is the minter).
-- Balances + transfer history are read on-chain; this table holds the name,
-- salt and cached address.

-- CreateTable
CREATE TABLE "FundTokenAccount" (
    "id"         TEXT NOT NULL,
    "fundId"     TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "saltNonce"  INTEGER NOT NULL,
    "address"    TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundTokenAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundTokenAccount_fundId_saltNonce_key" ON "FundTokenAccount"("fundId", "saltNonce");

-- CreateIndex
CREATE UNIQUE INDEX "FundTokenAccount_fundId_address_key" ON "FundTokenAccount"("fundId", "address");

-- CreateIndex
CREATE INDEX "FundTokenAccount_fundId_idx" ON "FundTokenAccount"("fundId");

-- AddForeignKey
ALTER TABLE "FundTokenAccount"
  ADD CONSTRAINT "FundTokenAccount_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
