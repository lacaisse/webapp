import "server-only";

import { randomBytes } from "node:crypto";

import { prisma } from "@/services/db/prisma";

// Verification tokens are 32 random bytes encoded base64url so they're safe
// to embed in a URL query parameter. 24h validity matches typical
// transactional-email behaviour and is long enough to survive a delivery
// delay or the user finding the email the next morning.
//
// EmailVerification is polymorphic across Member and Merchant — exactly
// one of `memberId` / `merchantId` is set per row.

const TOKEN_BYTES = 32;
const TTL_MS = 24 * 60 * 60 * 1000;

export function generateVerificationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function verificationExpiry(): Date {
  return new Date(Date.now() + TTL_MS);
}

export type VerifyEmailResult =
  | { ok: true; entity: "member"; memberId: string; fundId: string }
  | { ok: true; entity: "merchant"; merchantId: string; fundId: string }
  | { error: "not_found" | "expired" | "consumed" | "email_mismatch" };

/**
 * Consume a verification token in a single transaction. Returns an error if
 * the token doesn't exist, has been consumed already, is past its expiry,
 * or no longer matches the linked entity's current email (changed since
 * issue). On success: marks the verification consumed, stamps the entity's
 * `emailVerifiedAt`, and returns context for the caller to dispatch
 * follow-up emails (e.g. the welcome).
 */
export async function consumeVerificationToken(
  token: string,
): Promise<VerifyEmailResult> {
  return prisma.$transaction(async (tx) => {
    const v = await tx.emailVerification.findUnique({
      where: { token },
      include: {
        member: { select: { id: true, email: true, fundId: true } },
        merchant: { select: { id: true, email: true, fundId: true } },
      },
    });
    if (!v) return { error: "not_found" as const };
    if (v.consumedAt) return { error: "consumed" as const };
    if (v.expiresAt < new Date()) return { error: "expired" as const };

    if (v.merchant) {
      if (v.email !== v.merchant.email) {
        return { error: "email_mismatch" as const };
      }
      await tx.emailVerification.update({
        where: { token },
        data: { consumedAt: new Date() },
      });
      await tx.merchant.update({
        where: { id: v.merchant.id },
        data: { emailVerifiedAt: new Date() },
      });
      return {
        ok: true as const,
        entity: "merchant" as const,
        merchantId: v.merchant.id,
        fundId: v.merchant.fundId,
      };
    }

    if (v.member) {
      if (v.email !== v.member.email) {
        return { error: "email_mismatch" as const };
      }
      await tx.emailVerification.update({
        where: { token },
        data: { consumedAt: new Date() },
      });
      await tx.member.update({
        where: { id: v.member.id },
        data: { emailVerifiedAt: new Date() },
      });
      return {
        ok: true as const,
        entity: "member" as const,
        memberId: v.member.id,
        fundId: v.member.fundId,
      };
    }

    // Neither side set — schema violation, shouldn't happen. Treat as
    // not_found rather than 500.
    return { error: "not_found" as const };
  });
}
