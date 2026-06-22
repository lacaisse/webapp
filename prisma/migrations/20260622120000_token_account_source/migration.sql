-- Card-source accounts: a FundTokenAccount kind that carries a text `serial` so
-- the account can be referenced as a card's pull-from source on CitizenPay
-- (which keys sources by serial). Existing rows default to STANDARD with a NULL
-- serial.

-- CreateEnum
CREATE TYPE "FundTokenAccountKind" AS ENUM ('STANDARD', 'SOURCE');

-- AlterTable
ALTER TABLE "FundTokenAccount"
  ADD COLUMN "kind" "FundTokenAccountKind" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "serial" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FundTokenAccount_serial_key" ON "FundTokenAccount"("serial");
