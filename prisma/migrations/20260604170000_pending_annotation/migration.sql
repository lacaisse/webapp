-- Queue of userOp hashes awaiting resolution to their settlement tx hash, so a
-- TransactionAnnotation can be keyed by the real on-chain tx hash. A cron polls
-- the bundler until the userOp reaches a terminal state.

-- CreateTable
CREATE TABLE "PendingAnnotation" (
    "id"         TEXT NOT NULL,
    "fundId"     TEXT NOT NULL,
    "chainId"    INTEGER NOT NULL,
    "userOpHash" TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "note"       TEXT,
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingAnnotation_fundId_userOpHash_key" ON "PendingAnnotation"("fundId", "userOpHash");

-- CreateIndex
CREATE INDEX "PendingAnnotation_fundId_idx" ON "PendingAnnotation"("fundId");

-- AddForeignKey
ALTER TABLE "PendingAnnotation"
  ADD CONSTRAINT "PendingAnnotation_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
