-- Tracks who last held a card once it's unassigned (issue #222): members keep
-- writing their old card's serial on bank transfers after getting a
-- replacement, so bank-sync needs a way to trace an orphaned serial back to
-- the member and mint to their current primary card instead.

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "formerMemberId" TEXT;

-- CreateIndex
CREATE INDEX "Card_formerMemberId_idx" ON "Card"("formerMemberId");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_formerMemberId_fkey" FOREIGN KEY ("formerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
