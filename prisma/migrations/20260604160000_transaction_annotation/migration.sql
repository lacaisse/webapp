-- Per-fund annotation of on-chain transactions, keyed by tx hash. Lets history
-- views show what a transaction was for (payout fee sweep, account transfer, …)
-- next to the raw hash. Best-effort labels — never the source of truth for the
-- transaction itself.

-- CreateTable
CREATE TABLE "TransactionAnnotation" (
    "id"        TEXT NOT NULL,
    "fundId"    TEXT NOT NULL,
    "txHash"    TEXT NOT NULL,
    "kind"      TEXT NOT NULL,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAnnotation_fundId_txHash_key" ON "TransactionAnnotation"("fundId", "txHash");

-- CreateIndex
CREATE INDEX "TransactionAnnotation_fundId_idx" ON "TransactionAnnotation"("fundId");

-- AddForeignKey
ALTER TABLE "TransactionAnnotation"
  ADD CONSTRAINT "TransactionAnnotation_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
