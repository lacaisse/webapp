-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "TokenOperationType" AS ENUM ('MINT', 'BURN', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TokenOperationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" "TransactionDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "counterpartName" TEXT,
    "counterpartIban" TEXT,
    "counterpartReference" TEXT,
    "remittanceInfo" TEXT,
    "memberId" TEXT,
    "merchantId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "rawData" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenOperation" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "type" "TokenOperationType" NOT NULL,
    "memberId" TEXT,
    "account" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tierId" TEXT,
    "status" "TokenOperationStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenOperationSource" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "tokenOperationId" TEXT NOT NULL,
    "attributedAmount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenOperationSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankTransaction_fundId_occurredAt_idx" ON "BankTransaction"("fundId", "occurredAt");

-- CreateIndex
CREATE INDEX "BankTransaction_memberId_idx" ON "BankTransaction"("memberId");

-- CreateIndex
CREATE INDEX "BankTransaction_merchantId_idx" ON "BankTransaction"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_fundId_externalId_key" ON "BankTransaction"("fundId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenOperation_txHash_key" ON "TokenOperation"("txHash");

-- CreateIndex
CREATE INDEX "TokenOperation_fundId_status_idx" ON "TokenOperation"("fundId", "status");

-- CreateIndex
CREATE INDEX "TokenOperation_memberId_idx" ON "TokenOperation"("memberId");

-- CreateIndex
CREATE INDEX "TokenOperation_tierId_idx" ON "TokenOperation"("tierId");

-- CreateIndex
CREATE INDEX "TokenOperationSource_tokenOperationId_idx" ON "TokenOperationSource"("tokenOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenOperationSource_bankTransactionId_tokenOperationId_key" ON "TokenOperationSource"("bankTransactionId", "tokenOperationId");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperation" ADD CONSTRAINT "TokenOperation_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperation" ADD CONSTRAINT "TokenOperation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperation" ADD CONSTRAINT "TokenOperation_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "AllocationTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperationSource" ADD CONSTRAINT "TokenOperationSource_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperationSource" ADD CONSTRAINT "TokenOperationSource_tokenOperationId_fkey" FOREIGN KEY ("tokenOperationId") REFERENCES "TokenOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
