-- CreateTable
CREATE TABLE "CitizenPayConnectAttempt" (
    "state" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "returnHost" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "CitizenPayConnectAttempt_pkey" PRIMARY KEY ("state")
);

-- CreateIndex
CREATE INDEX "CitizenPayConnectAttempt_fundId_idx" ON "CitizenPayConnectAttempt"("fundId");

-- CreateIndex
CREATE INDEX "CitizenPayConnectAttempt_expiresAt_idx" ON "CitizenPayConnectAttempt"("expiresAt");

-- AddForeignKey
ALTER TABLE "CitizenPayConnectAttempt" ADD CONSTRAINT "CitizenPayConnectAttempt_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;
