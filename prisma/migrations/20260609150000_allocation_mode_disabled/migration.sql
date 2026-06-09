-- Allow allocation to be turned off for a fund: deposits are still mirrored
-- and matched to members, but nothing is minted and no periods are created.
ALTER TYPE "AllocationMode" ADD VALUE 'DISABLED';
