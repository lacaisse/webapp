-- Passkey-backed Safe owners. A member's Safe signing passkey (WebAuthn
-- credential, P-256 key) is bound to a Safe passkey signer contract whose
-- address is the Safe owner; the server holds no member key. Server-held
-- FundSigner keys are legacy: no new ones are created, and the ciphertext is
-- erased once no unarchived Safe lists the address any more.

-- AlterEnum
ALTER TYPE "FundSafeOwnerKind" ADD VALUE 'PASSKEY';

-- AlterEnum
ALTER TYPE "FundSafeSignatureSource" ADD VALUE 'PASSKEY';

-- AlterTable
ALTER TABLE "FundSigner"
  ALTER COLUMN "privateKeyEnc" DROP NOT NULL,
  ADD COLUMN "retiredAt" TIMESTAMP(3),
  ADD COLUMN "keyDeletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FundPasskeySigner" (
    "id" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKeyX" TEXT NOT NULL,
    "publicKeyY" TEXT NOT NULL,
    "verifiers" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "backupEligible" BOOLEAN NOT NULL,
    "backupState" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "deployTxHash" TEXT,
    "deployedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "replacedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundPasskeySigner_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "FundSafeOwner" ADD COLUMN "passkeyId" TEXT;

-- AlterTable
ALTER TABLE "FundSafeSignature" ADD COLUMN "passkeyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FundPasskeySigner_credentialId_key" ON "FundPasskeySigner"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "FundPasskeySigner_fundId_address_key" ON "FundPasskeySigner"("fundId", "address");

-- CreateIndex
CREATE INDEX "FundPasskeySigner_fundId_userId_idx" ON "FundPasskeySigner"("fundId", "userId");

-- AddForeignKey
ALTER TABLE "FundPasskeySigner" ADD CONSTRAINT "FundPasskeySigner_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundPasskeySigner" ADD CONSTRAINT "FundPasskeySigner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeOwner" ADD CONSTRAINT "FundSafeOwner_passkeyId_fkey" FOREIGN KEY ("passkeyId") REFERENCES "FundPasskeySigner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundSafeSignature" ADD CONSTRAINT "FundSafeSignature_passkeyId_fkey" FOREIGN KEY ("passkeyId") REFERENCES "FundPasskeySigner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
