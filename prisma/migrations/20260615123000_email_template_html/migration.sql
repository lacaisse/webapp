-- Rich-HTML body for editable email templates. When set, it's injected into
-- the branded shell instead of the plain-text body; bodyText keeps a
-- text/plain version (derived from the HTML on save).

-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN "bodyHtml" TEXT;
