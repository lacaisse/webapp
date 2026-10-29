-- Balance display on the Accounts pages: besides the fund token, a fund can
-- choose to show the chain's native coin (xDAI on Gnosis) and Monerium's EURe
-- on its named accounts and Safes (Settings → Token). Both off by default.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "showNativeBalance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "showEureBalance" BOOLEAN NOT NULL DEFAULT false;
