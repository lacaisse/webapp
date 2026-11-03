-- Token conversions (services/convert): one asset a fund account holds
-- turned into another (EURe → BREAD, BREAD → EURe) through a registered
-- converter — a CoW pre-sign swap and a BREAD mint / burn as Safe
-- transactions. A FundSafeTransaction of the new kind CONVERSION is one
-- on-chain step of a FundConversion (conversionId); the conversion's row
-- carries the quote, each leg's state and where it stands.


-- CreateEnum
CREATE TYPE "FundConversionHolderKind" AS ENUM ('SAFE', 'TOKEN_ACCOUNT');

-- CreateEnum
CREATE TYPE "FundConversionStatus" AS ENUM ('PROPOSED', 'READY', 'FILLING', 'DONE', 'EXPIRED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "FundSafeTxKind" ADD VALUE 'CONVERSION';

-- AlterTable
ALTER TABLE "FundSafeTransaction" ADD COLUMN     "conversionId" TEXT;

-- CreateTable
CREATE TABLE "FundConversion" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "holderKind" "FundConversionHolderKind" NOT NULL DEFAULT 'SAFE',
    "safeId" TEXT,
    "holderAddress" TEXT NOT NULL,
    "converterId" TEXT NOT NULL,
    "fromAsset" TEXT NOT NULL,
    "toAsset" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "expectedOut" TEXT NOT NULL,
    "minOut" TEXT NOT NULL,
    "amountOut" TEXT,
    "slippageBps" INTEGER NOT NULL,
    "status" "FundConversionStatus" NOT NULL DEFAULT 'READY',
    "round" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FundConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundConversion_fundId_status_idx" ON "FundConversion"("fundId", "status");

-- CreateIndex
CREATE INDEX "FundConversion_safeId_status_idx" ON "FundConversion"("safeId", "status");

-- CreateIndex
CREATE INDEX "FundSafeTransaction_conversionId_idx" ON "FundSafeTransaction"("conversionId");

-- AddForeignKey
ALTER TABLE "FundSafeTransaction" ADD CONSTRAINT "FundSafeTransaction_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "FundConversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundConversion" ADD CONSTRAINT "FundConversion_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundConversion" ADD CONSTRAINT "FundConversion_safeId_fkey" FOREIGN KEY ("safeId") REFERENCES "FundSafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundConversion" ADD CONSTRAINT "FundConversion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

