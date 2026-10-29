-- Fund Safes (multisig). Standard Safe 1.4.1 accounts owned N-of-M by fund
-- staff signer keys (FundSigner, one encrypted key per fund×user) and/or
-- external addresses, executed by a La Caisse relayer. FundSafeTransaction is
-- the proposal (SafeTx + EIP-712 hash), FundSafeSignature records who signed
-- it (in La Caisse, or imported from the Safe Transaction Service).

-- CreateEnum
CREATE TYPE "FundSafeStatus" AS ENUM ('DEPLOYING', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "FundSafeOwnerKind" AS ENUM ('MEMBER', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "FundSafeTxKind" AS ENUM ('TOKEN_TRANSFER', 'ADD_OWNER', 'REMOVE_OWNER', 'SWAP_OWNER', 'CHANGE_THRESHOLD', 'REJECTION');

-- CreateEnum
CREATE TYPE "FundSafeTxStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "FundSafeSignatureSource" AS ENUM ('LACAISSE', 'SAFE_WALLET');

-- CreateTable
CREATE TABLE "FundSigner" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundSigner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundSafe" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL DEFAULT 100,
    "saltNonce" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "status" "FundSafeStatus" NOT NULL DEFAULT 'DEPLOYING',
    "deployTxHash" TEXT,
    "errorMessage" TEXT,
    "createdById" UUID,
    "lastSyncedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundSafe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundSafeOwner" (
    "id" TEXT NOT NULL,
    "safeId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "FundSafeOwnerKind" NOT NULL,
    "signerId" TEXT,
    "label" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "FundSafeOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundSafeTransaction" (
    "id" TEXT NOT NULL,
    "safeId" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "kind" "FundSafeTxKind" NOT NULL,
    "to" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '0',
    "data" TEXT NOT NULL DEFAULT '0x',
    "operation" INTEGER NOT NULL DEFAULT 0,
    "safeTxHash" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "note" TEXT,
    "status" "FundSafeTxStatus" NOT NULL DEFAULT 'PENDING',
    "proposedById" UUID,
    "txHash" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "errorMessage" TEXT,
    "tokenOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundSafeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundSafeSignature" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "source" "FundSafeSignatureSource" NOT NULL,
    "signerId" TEXT,
    "userId" UUID,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundSafeSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundSigner_fundId_userId_key" ON "FundSigner"("fundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FundSigner_fundId_address_key" ON "FundSigner"("fundId", "address");

-- CreateIndex
CREATE INDEX "FundSafe_fundId_idx" ON "FundSafe"("fundId");

-- CreateIndex
CREATE UNIQUE INDEX "FundSafe_fundId_address_key" ON "FundSafe"("fundId", "address");

-- CreateIndex
CREATE INDEX "FundSafeOwner_safeId_idx" ON "FundSafeOwner"("safeId");

-- CreateIndex
CREATE UNIQUE INDEX "FundSafeOwner_safeId_address_key" ON "FundSafeOwner"("safeId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "FundSafeTransaction_safeTxHash_key" ON "FundSafeTransaction"("safeTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "FundSafeTransaction_tokenOperationId_key" ON "FundSafeTransaction"("tokenOperationId");

-- CreateIndex
CREATE INDEX "FundSafeTransaction_safeId_status_idx" ON "FundSafeTransaction"("safeId", "status");

-- CreateIndex
CREATE INDEX "FundSafeTransaction_safeId_nonce_idx" ON "FundSafeTransaction"("safeId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "FundSafeSignature_transactionId_ownerAddress_key" ON "FundSafeSignature"("transactionId", "ownerAddress");

-- AddForeignKey
ALTER TABLE "FundSigner" ADD CONSTRAINT "FundSigner_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSigner" ADD CONSTRAINT "FundSigner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafe" ADD CONSTRAINT "FundSafe_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafe" ADD CONSTRAINT "FundSafe_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeOwner" ADD CONSTRAINT "FundSafeOwner_safeId_fkey" FOREIGN KEY ("safeId") REFERENCES "FundSafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeOwner" ADD CONSTRAINT "FundSafeOwner_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "FundSigner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeTransaction" ADD CONSTRAINT "FundSafeTransaction_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeTransaction" ADD CONSTRAINT "FundSafeTransaction_safeId_fkey" FOREIGN KEY ("safeId") REFERENCES "FundSafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeSignature" ADD CONSTRAINT "FundSafeSignature_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "FundSafeTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeSignature" ADD CONSTRAINT "FundSafeSignature_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "FundSigner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeSignature" ADD CONSTRAINT "FundSafeSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
