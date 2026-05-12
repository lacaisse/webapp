-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'MEMBER_EMAIL_VERIFICATION';

-- DropForeignKey
ALTER TABLE "MerchantEmailVerification" DROP CONSTRAINT "MerchantEmailVerification_merchantId_fkey";

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "requireMemberEmailVerification" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requireMerchantEmailVerification" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "MerchantEmailVerification";

-- CreateTable
CREATE TABLE "EmailVerification" (
    "token" TEXT NOT NULL,
    "memberId" TEXT,
    "merchantId" TEXT,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "EmailVerification_memberId_idx" ON "EmailVerification"("memberId");

-- CreateIndex
CREATE INDEX "EmailVerification_merchantId_idx" ON "EmailVerification"("merchantId");

-- CreateIndex
CREATE INDEX "EmailVerification_expiresAt_idx" ON "EmailVerification"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
