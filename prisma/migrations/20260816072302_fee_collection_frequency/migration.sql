-- Fee collection cadence per fund (issue #155). Funds can now have the platform
-- fee collected once at month end instead of on every merchant payment. The
-- collection itself runs CitizenPay-side; this column is the canonical local
-- choice, mirrored to CP in the same PATCH as the rate (so `payoutFeeSynced`
-- covers both). Defaults to PER_PAYMENT so every existing fund keeps its
-- current behaviour.

-- CreateEnum
CREATE TYPE "FeeCollectionFrequency" AS ENUM ('PER_PAYMENT', 'MONTHLY');

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "feeCollectionFrequency" "FeeCollectionFrequency" NOT NULL DEFAULT 'PER_PAYMENT';
