-- Per-fund platform fee on merchant payments. Canonical here; pushed to
-- CitizenPay as basis points. `payoutFeeSynced` tracks whether the current
-- local value has been accepted by CP (the DB may lead CP after a failed push).

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "payoutFeePercentage" DECIMAL(5,2);
ALTER TABLE "Fund" ADD COLUMN "payoutFeeSynced" BOOLEAN NOT NULL DEFAULT true;
