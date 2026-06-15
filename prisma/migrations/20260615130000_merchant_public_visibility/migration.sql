-- Public-directory visibility flag for merchants. When false, the merchant is
-- hidden from public-facing surfaces (the {shopList} email variable today; the
-- public directory/map later). Independent of `status`. Existing rows default
-- to visible so the current roster is unchanged.

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN "publiclyVisible" BOOLEAN NOT NULL DEFAULT true;
