-- Fund payment settings (citizenpay/api#277 + #278, 2026-11-13).
-- Three per-fund settings La Caisse owns and pushes to Citizen Pay with
-- PATCH /v2/treasury, each with its own "synced" flag:
--   * feeAccountAddress   — the fund account transaction fees are sent to
--                           shortly after each payment (null = swept at
--                           payout, as before);
--   * platformPayoutFeeBps — the platform fee charged to merchants only at
--                           payout, basis points (0 = none);
--   * earlyPaidMaxCents   — the instant terminal confirmation cap in cents
--                           (null = Citizen Pay's default, 0 = no limit).
-- Every default reproduces today's behaviour and every flag starts true
-- ("nothing to push"), so no existing fund sends anything on deploy.
-- FundPaymentSettingEvent records who applied a setting on Citizen Pay and
-- when (append-only, cascades with the fund).
-- Additive only: nullable columns or constant defaults, one new table.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "earlyPaidMaxCents" INTEGER,
ADD COLUMN     "earlyPaidMaxCentsSynced" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "feeAccountAddress" TEXT,
ADD COLUMN     "feeAccountSynced" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "platformPayoutFeeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "platformPayoutFeeSynced" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "FundPaymentSettingEvent" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT,
    "action" TEXT NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundPaymentSettingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundPaymentSettingEvent_fundId_createdAt_idx" ON "FundPaymentSettingEvent"("fundId", "createdAt");

-- AddForeignKey
ALTER TABLE "FundPaymentSettingEvent" ADD CONSTRAINT "FundPaymentSettingEvent_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
