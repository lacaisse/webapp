-- Fixed platform fee per order, per fund (plan "fund fixed fee", 2026-11-12).
-- Beside the percentage (`payoutFeePercentage`), a fund admin can now set a
-- fixed amount CitizenPay charges on every order, in euro cents (10 = €0.10).
-- La Caisse stays canonical, exactly like the rate: this column is written
-- first, then pushed to CP in the same PATCH /v2/treasury as rate + cadence
-- (`fixedFeeCents`), and the existing `payoutFeeSynced` flag covers all three.
-- The businesses exempt from the fixed fee live only on CitizenPay's side
-- (/v2/treasury/fee-waivers), so there is no table for them here.
-- Defaults to 0 so every existing fund keeps its current behaviour.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "payoutFixedFeeCents" INTEGER NOT NULL DEFAULT 0;
