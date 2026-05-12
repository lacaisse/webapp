-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'ACTIVATED');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "referralCode" TEXT;

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "codeUsed" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "activatedAt" TIMESTAMP(3),
    "rewardOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeId_key" ON "Referral"("refereeId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_rewardOperationId_key" ON "Referral"("rewardOperationId");

-- CreateIndex
CREATE INDEX "Referral_fundId_status_idx" ON "Referral"("fundId", "status");

-- CreateIndex
CREATE INDEX "Referral_sponsorId_idx" ON "Referral"("sponsorId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_fundId_referralCode_key" ON "Member"("fundId", "referralCode");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_rewardOperationId_fkey" FOREIGN KEY ("rewardOperationId") REFERENCES "TokenOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
