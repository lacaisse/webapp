-- Mint/burn audit trail: record who (acting admin) or what (system origin)
-- triggered each annotated on-chain op. Both columns are nullable so existing
-- (pre-audit) rows stay NULL; new rows are written by the actions/crons that
-- produce the tx. `triggeredByUserId` is NULL for cron-driven ops.

-- AlterTable
ALTER TABLE "TransactionAnnotation"
  ADD COLUMN "trigger"           TEXT,
  ADD COLUMN "triggeredByUserId" UUID;

-- AlterTable
ALTER TABLE "PendingAnnotation"
  ADD COLUMN "trigger"           TEXT,
  ADD COLUMN "triggeredByUserId" UUID;

-- CreateIndex
CREATE INDEX "TransactionAnnotation_triggeredByUserId_idx" ON "TransactionAnnotation"("triggeredByUserId");

-- CreateIndex
CREATE INDEX "PendingAnnotation_triggeredByUserId_idx" ON "PendingAnnotation"("triggeredByUserId");

-- AddForeignKey
ALTER TABLE "TransactionAnnotation"
  ADD CONSTRAINT "TransactionAnnotation_triggeredByUserId_fkey"
  FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnnotation"
  ADD CONSTRAINT "PendingAnnotation_triggeredByUserId_fkey"
  FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
