-- Add the OPERATOR per-fund role (ranked between ADMIN and VIEWER in app code).
ALTER TYPE "FundRole" ADD VALUE IF NOT EXISTS 'OPERATOR' BEFORE 'VIEWER';
