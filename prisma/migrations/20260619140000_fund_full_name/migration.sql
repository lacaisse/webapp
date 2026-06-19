-- The fund's full / legal name (e.g. "Caisse Locale d'Alimentation Solidaire de
-- Schaerbeek" for the short name "La CLASS"). Optional — falls back to `name`.
-- Surfaced in member-facing documents via the {{full_name}} token; editable in
-- Settings → General.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "fullName" TEXT;
