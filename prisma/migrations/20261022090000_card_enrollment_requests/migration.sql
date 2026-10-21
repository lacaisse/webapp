-- Cross-fund card enrollment. A physical card (NFC serial) is issued by one
-- fund but may be used by others: the requesting fund files a
-- CardEnrollmentRequest against the issuer's Card row, the issuer fund
-- accepts or rejects, and on accept the requester enrolls the serial at
-- CitizenPay with its own key and gets its own Card row. That needs
-- Card.serialNumber and Card.account to be unique per fund instead of
-- globally (the on-chain account is the same across funds for one serial),
-- so the global unique indexes are replaced by (fundId, …) ones, plus a plain
-- serialNumber index for the cross-fund lookup.

-- CreateEnum
CREATE TYPE "CardEnrollmentRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- DropIndex
DROP INDEX "Card_serialNumber_key";

-- DropIndex
DROP INDEX "Card_account_key";

-- CreateTable
CREATE TABLE "CardEnrollmentRequest" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "issuerFundId" TEXT NOT NULL,
    "requesterFundId" TEXT NOT NULL,
    "requestedById" UUID NOT NULL,
    "requestedNumber" INTEGER,
    "memberId" TEXT,
    "holderName" TEXT,
    "status" "CardEnrollmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "enrolledCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardEnrollmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardEnrollmentRequest_enrolledCardId_key" ON "CardEnrollmentRequest"("enrolledCardId");

-- CreateIndex
CREATE INDEX "CardEnrollmentRequest_issuerFundId_status_idx" ON "CardEnrollmentRequest"("issuerFundId", "status");

-- CreateIndex
CREATE INDEX "CardEnrollmentRequest_requesterFundId_status_idx" ON "CardEnrollmentRequest"("requesterFundId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CardEnrollmentRequest_cardId_requesterFundId_key" ON "CardEnrollmentRequest"("cardId", "requesterFundId");

-- CreateIndex
CREATE INDEX "Card_serialNumber_idx" ON "Card"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Card_fundId_serialNumber_key" ON "Card"("fundId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Card_fundId_account_key" ON "Card"("fundId", "account");

-- AddForeignKey
ALTER TABLE "CardEnrollmentRequest" ADD CONSTRAINT "CardEnrollmentRequest_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEnrollmentRequest" ADD CONSTRAINT "CardEnrollmentRequest_issuerFundId_fkey" FOREIGN KEY ("issuerFundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEnrollmentRequest" ADD CONSTRAINT "CardEnrollmentRequest_requesterFundId_fkey" FOREIGN KEY ("requesterFundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEnrollmentRequest" ADD CONSTRAINT "CardEnrollmentRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardEnrollmentRequest" ADD CONSTRAINT "CardEnrollmentRequest_enrolledCardId_fkey" FOREIGN KEY ("enrolledCardId") REFERENCES "Card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

