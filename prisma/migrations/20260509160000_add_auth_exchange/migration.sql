-- CreateTable
CREATE TABLE "AuthExchange" (
    "code" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "targetHost" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AuthExchange_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "AuthExchange_expiresAt_idx" ON "AuthExchange"("expiresAt");
