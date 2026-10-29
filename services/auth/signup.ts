// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { prisma } from "@/services/db/prisma";
import { inviteTokenFromReturnTo } from "@/services/fund-team/invite-rules";
import { auth } from "./better-auth";

// Account creation (review finding S5). Better Auth's public
// `/api/auth/sign-up/email` is disabled (`emailAndPassword.disableSignUp`),
// so this is the only way an account comes into being: through a live staff
// invite whose token the visitor holds (it reached them by email), for
// exactly the invited address. Holding the token proves control of the
// inbox, so the account starts email-verified. There is no other
// self-service path — the waitlist only records interest.

export type CreateInvitedAccountResult =
  | { ok: true; user: { id: string; email: string } }
  | { error: "no_invite" | "email_mismatch" | "exists" };

export async function createInvitedAccount(args: {
  email: string;
  password: string;
  returnTo: string | undefined;
}): Promise<CreateInvitedAccountResult> {
  const token = inviteTokenFromReturnTo(args.returnTo);
  if (!token) return { error: "no_invite" };

  const invite = await prisma.fundInvite.findUnique({
    where: { token },
    select: { email: true, acceptedAt: true, expiresAt: true },
  });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() < Date.now()) {
    return { error: "no_invite" };
  }

  const email = args.email.trim().toLowerCase();
  if (invite.email.toLowerCase() !== email) return { error: "email_mismatch" };

  const ctx = await auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) return { error: "exists" };

  // Same writes Better Auth's sign-up does: a user row, then its credential
  // account carrying the password hash (ctx.password = the configured
  // hasher, so sign-in verifies it the usual way).
  const user = await ctx.internalAdapter.createUser(
    {
      email,
      name: email.split("@")[0] ?? "",
      emailVerified: true,
    },
    { method: "email-password" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(args.password),
  });
  return { ok: true, user: { id: user.id, email: user.email } };
}
