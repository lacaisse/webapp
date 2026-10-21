-- Terminal top-ups minted by the issuer (Citizen Pay "top-up by payment", the
-- issuer-mints amendment): a member taps a card on a pay-pos terminal and
-- pays by Viva or QR; Citizen Pay exposes the settled order on
-- GET /v2/treasury/topups and La Caisse mints it to the card with the fund's
-- own minter Safe (app/api/cron/topups → services/topup-orders/run.ts).
--
-- TokenOperationType.TOPUP / TOPUP_REVERSAL mark those mints / burns; the
-- order id on the row is the local idempotency key. Fund.topUpOrdersRun* hold
-- the last cron run per fund for Settings → Token.

-- AlterEnum
ALTER TYPE "TokenOperationType" ADD VALUE 'TOPUP';
ALTER TYPE "TokenOperationType" ADD VALUE 'TOPUP_REVERSAL';

-- AlterTable
ALTER TABLE "TokenOperation" ADD COLUMN "topUpOrderId" INTEGER,
ADD COLUMN "topUpSerial" TEXT,
ADD COLUMN "topUpPlaceName" TEXT;

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "topUpOrdersRunAt" TIMESTAMP(3),
ADD COLUMN "topUpOrdersRunMinted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "topUpOrdersRunReversed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "topUpOrdersRunFailed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "topUpOrdersRunError" TEXT;

-- CreateIndex
CREATE INDEX "TokenOperation_fundId_topUpOrderId_idx" ON "TokenOperation"("fundId", "topUpOrderId");
