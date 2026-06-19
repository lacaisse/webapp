-- The fund's public website URL. Surfaced in member-facing documents (the
-- card onboarding letter's {{website}} token); editable in Settings → Branding.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN "websiteUrl" TEXT;
