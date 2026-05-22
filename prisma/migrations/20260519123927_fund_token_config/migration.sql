-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "tokenChainId" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "Fund" ADD COLUMN "tokenAddress" TEXT;
ALTER TABLE "Fund" ADD COLUMN "tokenDecimals" INTEGER;
ALTER TABLE "Fund" ADD COLUMN "tokenMinterPrivateKeyEnc" TEXT;
ALTER TABLE "Fund" ADD COLUMN "tokenMinterEoaAddress" TEXT;
ALTER TABLE "Fund" ADD COLUMN "tokenMinterSmartAccountAddress" TEXT;
ALTER TABLE "Fund" ADD COLUMN "tokenMintEnabledAt" TIMESTAMP(3);
