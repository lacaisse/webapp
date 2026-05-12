-- AlterTable
ALTER TABLE "Member" DROP COLUMN "monthlyContribution";

-- CreateTable
CREATE TABLE "AllocationTier" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minContribution" DECIMAL(10,2) NOT NULL,
    "maxContribution" DECIMAL(10,2) NOT NULL,
    "allocationAmount" DECIMAL(10,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AllocationTier_fundId_idx" ON "AllocationTier"("fundId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationTier_fundId_name_key" ON "AllocationTier"("fundId", "name");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "AllocationTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationTier" ADD CONSTRAINT "AllocationTier_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
