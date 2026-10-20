-- Open-banking card top-ups for PAY_AND_GO funds (/pay/<serial>): a member
-- pays the fund's bank account through CitizenPay's treasury sign door and
-- La Caisse mints the same amount to their card (CitizenPay does not mint for
-- top-up-only payment requests). See model CardTopUp.
--
-- BankMatchMethod.CARD_TOPUP marks the deposit (remittance
-- "cp-<paymentRequestId>") as already credited by the top-up, so bank-sync
-- neither tier-mints it nor queues it for manual attribution.

-- CreateEnum
CREATE TYPE "CardTopUpStatus" AS ENUM ('PENDING', 'SIGNED', 'MINTED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "BankMatchMethod" ADD VALUE 'CARD_TOPUP';

-- CreateTable
CREATE TABLE "CardTopUp" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "memberId" TEXT,
    "account" TEXT NOT NULL,
    "citizenPayPaymentRequestId" INTEGER,
    "amountCents" INTEGER NOT NULL,
    "status" "CardTopUpStatus" NOT NULL DEFAULT 'PENDING',
    "tokenOperationId" TEXT,
    "bankTransactionId" TEXT,
    "mintTxHash" TEXT,
    "mintUserOpHash" TEXT,
    "mintAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextMintAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardTopUp_tokenOperationId_key" ON "CardTopUp"("tokenOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "CardTopUp_bankTransactionId_key" ON "CardTopUp"("bankTransactionId");

-- CreateIndex
CREATE INDEX "CardTopUp_fundId_status_idx" ON "CardTopUp"("fundId", "status");

-- CreateIndex
CREATE INDEX "CardTopUp_cardId_idx" ON "CardTopUp"("cardId");

-- CreateIndex
CREATE INDEX "CardTopUp_memberId_idx" ON "CardTopUp"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "CardTopUp_fundId_citizenPayPaymentRequestId_key" ON "CardTopUp"("fundId", "citizenPayPaymentRequestId");

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_tokenOperationId_fkey" FOREIGN KEY ("tokenOperationId") REFERENCES "TokenOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

