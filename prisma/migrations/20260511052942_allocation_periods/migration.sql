-- CreateEnum
CREATE TYPE "AllocationPeriodStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "allocationPeriodId" TEXT;

-- AlterTable
ALTER TABLE "TokenOperation" ADD COLUMN     "allocationPeriodId" TEXT;

-- CreateTable
CREATE TABLE "AllocationPeriod" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "cutoffDate" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "status" "AllocationPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AllocationPeriod_fundId_status_idx" ON "AllocationPeriod"("fundId", "status");

-- CreateIndex
CREATE INDEX "AllocationPeriod_fundId_cutoffDate_idx" ON "AllocationPeriod"("fundId", "cutoffDate");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationPeriod_fundId_label_key" ON "AllocationPeriod"("fundId", "label");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_allocationPeriodId_fkey" FOREIGN KEY ("allocationPeriodId") REFERENCES "AllocationPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenOperation" ADD CONSTRAINT "TokenOperation_allocationPeriodId_fkey" FOREIGN KEY ("allocationPeriodId") REFERENCES "AllocationPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationPeriod" ADD CONSTRAINT "AllocationPeriod_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
