-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('PAYMENT_REMINDER_FIRST', 'PAYMENT_REMINDER_SECOND', 'PAYMENT_CONFIRMATION', 'ALLOCATION_CONFIRMATION', 'PAYMENT_FORGOTTEN', 'MEMBER_WELCOME', 'MEMBER_ACTIVATED', 'MERCHANT_WELCOME', 'MERCHANT_APPROVED', 'MERCHANT_REJECTED', 'REFERRAL_BONUS_AWARDED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "emailUnsubscribed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailUnsubscribedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "toEmail" TEXT NOT NULL,
    "memberId" TEXT,
    "merchantId" TEXT,
    "bankTransactionId" TEXT,
    "tokenOperationId" TEXT,
    "allocationPeriodId" TEXT,
    "referralId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "resendMessageId" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "errorMessage" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Email_idempotencyKey_key" ON "Email"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Email_resendMessageId_key" ON "Email"("resendMessageId");

-- CreateIndex
CREATE INDEX "Email_fundId_type_sentAt_idx" ON "Email"("fundId", "type", "sentAt");

-- CreateIndex
CREATE INDEX "Email_memberId_idx" ON "Email"("memberId");

-- CreateIndex
CREATE INDEX "Email_merchantId_idx" ON "Email"("merchantId");

-- CreateIndex
CREATE INDEX "Email_status_idx" ON "Email"("status");

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_tokenOperationId_fkey" FOREIGN KEY ("tokenOperationId") REFERENCES "TokenOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_allocationPeriodId_fkey" FOREIGN KEY ("allocationPeriodId") REFERENCES "AllocationPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;
