// SPDX-License-Identifier: AGPL-3.0-or-later
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
  | {
      ok: true;
      entity: "member";
      memberId: string;
      fundId: string;
      // Set when this verification came from the member LOGIN sign-up and
      // the member is now linked to (or confirmed as) that User — the
      // caller syncs the member's card holders.
      linkedUserId: string | null;
      // True when this consumption is what linked an EXISTING member to the
      // login (the member had no User before): no applicant welcome then.
      wasLinked: boolean;
    }
  | { ok: true; entity: "merchant"; merchantId: string; fundId: string }
  | {
      error:
        | "not_found"
        | "expired"
        | "consumed"
        | "email_mismatch"
        // Member LOGIN tokens only: the clicker must be signed in as the
        // User the token was minted for (proof of owning that login), and
        // the fund must have member login on. Neither consumes the token.
        | "login_required"
        | "login_disabled";
    };

export type PeekEmailVerification =
  | {
      ok: true;
      // The User a member-login sign-up minted this token for; null on the
      // classic /join and merchant tokens.
      userId: string | null;
      memberId: string | null;
      merchantId: string | null;
      fundId: string | null;
      memberLoginEnabled: boolean;
    }
  | { error: "not_found" | "expired" | "consumed" };

/**
 * What a token is for, without consuming it — so the verification page can
 * decide whether it is a plain /join link (consumed on the GET) or a member
 * LOGIN link (needs the signed-in owner and a POST).
 */
export async function peekVerificationToken(token: string): Promise<PeekEmailVerification> {
  const v = await prisma.emailVerification.findUnique({
    where: { token },
    select: {
      userId: true,
      memberId: true,
      merchantId: true,
      consumedAt: true,
      expiresAt: true,
      member: { select: { fundId: true, fund: { select: { memberLoginEnabled: true } } } },
      merchant: { select: { fundId: true } },
    },
  });
  if (!v) return { error: "not_found" };
  if (v.consumedAt) return { error: "consumed" };
  if (v.expiresAt < new Date()) return { error: "expired" };
  return {
    ok: true,
    userId: v.userId,
    memberId: v.memberId,
    merchantId: v.merchantId,
    fundId: v.member?.fundId ?? v.merchant?.fundId ?? null,
    memberLoginEnabled: v.member?.fund.memberLoginEnabled ?? false,
  };
}

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
  opts: {
    // The signed-in user, for member LOGIN tokens: the link is only ever
    // made for the User the token was minted for, and only when that user
    // is the one clicking (a session proves the password; a link landing in
    // someone else's inbox, or a scanner pre-fetch, proves nothing).
    sessionUserId?: string | null;
  } = {},
): Promise<VerifyEmailResult> {
  return prisma.$transaction(async (tx) => {
    const v = await tx.emailVerification.findUnique({
      where: { token },
      include: {
        member: {
          select: {
            id: true,
            email: true,
            fundId: true,
            userId: true,
            fund: { select: { memberLoginEnabled: true } },
          },
        },
        merchant: { select: { id: true, email: true, fundId: true } },
        user: { select: { id: true, email: true } },
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
      // Member LOGIN verification (services/member/auth.ts): the token was
      // minted for exactly `v.user`. Nothing is consumed unless the fund
      // still has member login on and the clicker IS that user.
      if (v.userId) {
        if (!v.member.fund.memberLoginEnabled) return { error: "login_disabled" as const };
        if (!opts.sessionUserId || opts.sessionUserId !== v.userId) {
          return { error: "login_required" as const };
        }
      }
      await tx.emailVerification.update({
        where: { token },
        data: { consumedAt: new Date() },
      });

      // The link lands when the member has no login yet or already has this
      // one; a member linked to another user meanwhile keeps that login —
      // this token then only verifies the member's address, and the other
      // User stays unverified (and can't attach anything). The address must
      // still be the one the token proves.
      const linkUser =
        v.user &&
        v.user.email.toLowerCase() === v.email.toLowerCase() &&
        (v.member.userId === null || v.member.userId === v.user.id)
          ? v.user
          : null;
      const wasLinked = Boolean(linkUser) && v.member.userId === null;

      await tx.member.update({
        where: { id: v.member.id },
        data: {
          emailVerifiedAt: new Date(),
          ...(linkUser ? { userId: linkUser.id } : {}),
        },
      });
      if (linkUser) {
        await tx.user.update({
          where: { id: linkUser.id },
          data: { emailVerified: true },
        });
      }
      return {
        ok: true as const,
        entity: "member" as const,
        memberId: v.member.id,
        fundId: v.member.fundId,
        linkedUserId: linkUser?.id ?? null,
        wasLinked,
      };
    }

    // Neither side set — schema violation, shouldn't happen. Treat as
    // not_found rather than 500.
    return { error: "not_found" as const };
  });
}
