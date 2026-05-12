-- CreateEnum
CREATE TYPE "AllocationMode" AS ENUM ('FIXED_PERIOD', 'PAY_AND_GO');

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "allocationMode" "AllocationMode" NOT NULL DEFAULT 'FIXED_PERIOD',
ADD COLUMN     "citizenPayFundId" TEXT,
ADD COLUMN     "citizenPayLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "defaultLocale" TEXT NOT NULL DEFAULT 'fr',
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "primaryColor" TEXT,
ADD COLUMN     "privacyUrl" TEXT,
ADD COLUMN     "referralBonusAmount" DECIMAL(10,2),
ADD COLUMN     "termsUrl" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Brussels',
ADD COLUMN     "tokenName" TEXT,
ADD COLUMN     "tokenSymbol" TEXT;
