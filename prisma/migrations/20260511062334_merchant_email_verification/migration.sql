-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'MERCHANT_EMAIL_VERIFICATION';

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MerchantEmailVerification" (
    "token" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "MerchantEmailVerification_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "MerchantEmailVerification_merchantId_idx" ON "MerchantEmailVerification"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantEmailVerification_expiresAt_idx" ON "MerchantEmailVerification"("expiresAt");

-- AddForeignKey
ALTER TABLE "MerchantEmailVerification" ADD CONSTRAINT "MerchantEmailVerification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
