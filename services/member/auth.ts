// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { auth } from "@/services/auth/better-auth";
import { syncMemberCardHolders } from "@/services/card/holder-sync";
import type { AllocationMode } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { sendMemberLoginVerification } from "@/services/email/transactional";
import {
  generateVerificationToken,
  verificationExpiry,
} from "@/services/email/verification";
import { getFundUrl } from "@/services/fund/host";

import { generatePaymentReference } from "./payment-reference";
import type { BuiltinSignupInput, ExtraValue } from "./schema";
import {
  isUniqueViolationOn,
  resolveMemberSignup,
  type SignupTranslate,
} from "./signup-core";

// Member login (plan "Bread card-holder voting", D2/D3, PR W-1): a card
// holder gets ONE login for life — a Better Auth `User` (email + password,
// passkeys later) — linked to one `Member` per fund through `Member.userId`.
//
// How the User is created. Better Auth's own sign-up endpoint stays disabled
// (`emailAndPassword.disableSignUp`, review S5: staff accounts come only from
// an invite — services/auth/signup.ts) and `auth.api.signUpEmail` honours
// that flag, so the member path writes the two rows Better Auth's sign-up
// would write — the `User` and its `credential` `Account` carrying the
// password hash from the configured hasher (`auth.$context.password`, the
// same one sign-in verifies with) — through Prisma, inside the SAME
// transaction as the Member. The internal adapter can't join a Prisma
// transaction, which is why it isn't used here; the invite path
// (createInvitedAccount) does the same writes through the adapter.
//
// Two shapes of sign-up at a fund with member login on:
//   - no Member with that email yet → User + Member (status NEW, `userId`
//     set, `emailVerifiedAt` null) in one transaction, plus the verification
//     email; the account becomes attached-capable once the link is clicked.
//   - a Member with that email exists (admin-created, paper form, earlier
//     /join) and has no login → the User is created, the Member is NOT
//     touched: `Member.userId` is set only when the verification link is
//     clicked (services/email/verification.ts), together with
//     `Member.emailVerifiedAt` and `User.emailVerified`. The email proves the
//     inbox, so nobody can take over a membership by knowing its address.
//   - the email already has a User → refuse ("sign in instead"). Joining a
//     second fund with an existing login is W-2 (cross-fund pre-fill).

export type MemberLoginFund = {
  id: string;
  name: string;
  domain: string;
  allocationMode: AllocationMode;
  memberLoginEnabled: boolean;
  primaryColor: string | null;
  logoUrl: string | null;
  senderEmail: string | null;
};

export type SignUpMemberInput = {
  builtins: BuiltinSignupInput;
  password: string;
  applicationData?: Record<string, ExtraValue>;
  referralCode?: string | null;
  locale: string | null;
};

export type SignUpMemberResult =
  | {
      ok: true;
      userId: string;
      // "created": a new Member with the login already set; "link": an
      // existing Member, linked once the email is verified.
      mode: "created" | "link";
    }
  | {
      ok: false;
      error:
        | "disabled"
        | "account_exists"
        | "membership_has_login"
        | "invalid"
        | "generic";
      message?: string;
      field?: "contributionAmount";
    };

const MAX_REFERENCE_RETRIES = 5;

export async function signUpMember(
  fund: MemberLoginFund,
  input: SignUpMemberInput,
  t: SignupTranslate,
): Promise<SignUpMemberResult> {
  if (!fund.memberLoginEnabled) return { ok: false, error: "disabled" };

  const resolution = await resolveMemberSignup({
    fund,
    builtins: input.builtins,
    applicationData: input.applicationData,
    referralCode: input.referralCode,
    t,
  });
  if (!resolution.ok) {
    return { ok: false, error: "invalid", message: resolution.error, field: resolution.field };
  }
  const { contributionAmount, builtinColumns, applicationData, sponsor } =
    resolution.resolved;

  // Better Auth lowercases on sign-in (`findUserByEmail(email.toLowerCase())`),
  // so the stored address is lowercase too — exactly like the invite path.
  const email = input.builtins.email.trim().toLowerCase();
  const firstName = input.builtins.firstName.trim();
  const lastName = input.builtins.lastName.trim();

  const [existingUser, existingMember] = await Promise.all([
    prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    }),
    prisma.member.findFirst({
      where: { fundId: fund.id, email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true, firstName: true, userId: true },
    }),
  ]);
  if (existingUser) return { ok: false, error: "account_exists" };
  if (existingMember?.userId) return { ok: false, error: "membership_has_login" };

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(input.password);

  // Retry loop on paymentReference collisions (new members only). INSERT and
  // catch P2002 rather than SELECT-then-INSERT, to avoid TOCTOU — same as
  // the /join action.
  for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt++) {
    const token = generateVerificationToken();
    let created: { userId: string; memberId: string; memberEmail: string; firstName: string; emailId: string };
    try {
      created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            name: `${firstName} ${lastName}`.trim(),
            emailVerified: false,
          },
          select: { id: true },
        });
        await tx.account.create({
          data: {
            userId: user.id,
            providerId: "credential",
            accountId: user.id,
            password: passwordHash,
          },
        });

        let member: { id: string; email: string; firstName: string };
        if (existingMember) {
          member = existingMember;
        } else {
          member = await tx.member.create({
            data: {
              fundId: fund.id,
              userId: user.id,
              email,
              firstName,
              lastName,
              locale: input.locale,
              status: "NEW",
              paymentReference: generatePaymentReference(),
              contributionAmount,
              emailVerifiedAt: null,
              ...builtinColumns,
              applicationData: applicationData ?? undefined,
            },
            select: { id: true, email: true, firstName: true },
          });
          if (sponsor) {
            await tx.referral.create({
              data: {
                fundId: fund.id,
                sponsorId: sponsor.id,
                refereeId: member.id,
                codeUsed: sponsor.referralCode,
              },
            });
          }
        }

        await tx.emailVerification.create({
          data: {
            token,
            memberId: member.id,
            userId: user.id,
            email: member.email,
            expiresAt: verificationExpiry(),
          },
        });
        const emailRow = await tx.email.create({
          data: {
            fundId: fund.id,
            type: "MEMBER_EMAIL_VERIFICATION",
            toEmail: member.email,
            memberId: member.id,
            idempotencyKey: `MEMBER_EMAIL_VERIFICATION:token:${token}`,
            subject: t("memberLogin.emails.verify.subject", { fundName: fund.name }),
          },
          select: { id: true },
        });
        return {
          userId: user.id,
          memberId: member.id,
          memberEmail: member.email,
          firstName: member.firstName,
          emailId: emailRow.id,
        };
      });
    } catch (e) {
      if (isUniqueViolationOn(e, "paymentReference")) continue;
      // A User or Member with that email appeared between the check and the
      // insert (a double submit): the same answer as the check gives.
      if (isUniqueViolationOn(e, "email")) return { ok: false, error: "account_exists" };
      console.error("[member-login] sign-up failed", fund.id, e);
      return { ok: false, error: "generic" };
    }

    // Outside the transaction: the send (fail-soft, logged by the sender).
    await sendMemberLoginVerification({
      emailId: created.emailId,
      toEmail: created.memberEmail,
      fund: {
        name: fund.name,
        primaryColor: fund.primaryColor,
        logoUrl: fund.logoUrl,
        senderEmail: fund.senderEmail,
      },
      firstName: created.firstName,
      verifyUrl: `${getFundUrl(fund.domain)}/verify-email?token=${encodeURIComponent(token)}`,
    });
    return { ok: true, userId: created.userId, mode: existingMember ? "link" : "created" };
  }
  return { ok: false, error: "generic" };
}

/**
 * A fresh verification email for a signed-in member whose login isn't
 * verified yet (or whose link is still pending). Mints a new token bound to
 * the same user; older tokens stay valid until they expire.
 */
export async function resendMemberVerification(
  fund: MemberLoginFund,
  member: { id: string; email: string; firstName: string; userId: string | null },
  user: { id: string },
  t: SignupTranslate,
): Promise<void> {
  const token = generateVerificationToken();
  const emailRow = await prisma.$transaction(async (tx) => {
    await tx.emailVerification.create({
      data: {
        token,
        memberId: member.id,
        userId: user.id,
        email: member.email,
        expiresAt: verificationExpiry(),
      },
    });
    return tx.email.create({
      data: {
        fundId: fund.id,
        type: "MEMBER_EMAIL_VERIFICATION",
        toEmail: member.email,
        memberId: member.id,
        idempotencyKey: `MEMBER_EMAIL_VERIFICATION:token:${token}`,
        subject: t("memberLogin.emails.verify.subject", { fundName: fund.name }),
      },
      select: { id: true },
    });
  });
  await sendMemberLoginVerification({
    emailId: emailRow.id,
    toEmail: member.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
      senderEmail: fund.senderEmail,
    },
    firstName: member.firstName,
    verifyUrl: `${getFundUrl(fund.domain)}/verify-email?token=${encodeURIComponent(token)}`,
  });
}

/**
 * "Remove my login" (D3 detaching): clears `Member.userId`, which makes the
 * member's cards public again (holder sync → DELETE). When the User is
 * linked to nothing else — no other Member, no staff FundMember — the User
 * itself goes too (sessions, credential, passkeys cascade): a credential
 * that owns nothing would only block the same address from signing up
 * again. Returns whether the user row was deleted.
 */
export async function removeMemberLogin(args: {
  memberId: string;
  userId: string;
}): Promise<{ userDeleted: boolean }> {
  const userDeleted = await prisma.$transaction(async (tx) => {
    await tx.member.updateMany({
      where: { id: args.memberId, userId: args.userId },
      data: { userId: null },
    });
    const [otherMembers, staffRows] = await Promise.all([
      tx.member.count({ where: { userId: args.userId } }),
      tx.fundMember.count({ where: { userId: args.userId } }),
    ]);
    if (otherMembers > 0 || staffRows > 0) return false;
    await tx.user.delete({ where: { id: args.userId } });
    return true;
  });
  // The member's cards are public again; tell Citizen Pay now (awaited:
  // the caller is about to redirect, there is no response to defer behind).
  await syncMemberCardHolders(args.memberId);
  return { userDeleted };
}
