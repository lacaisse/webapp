-- Cache the place's geo-coordinates on Merchant. CitizenPay's places
-- list now ships `latitude`/`longitude` per place; storing them locally
-- avoids hitting CP on every directory or map render. Nullable: places
-- can exist on CP without coordinates set yet.

ALTER TABLE "Merchant" ADD COLUMN "latitude"  DOUBLE PRECISION;
ALTER TABLE "Merchant" ADD COLUMN "longitude" DOUBLE PRECISION;
