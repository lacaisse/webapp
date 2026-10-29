// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure rules of the staff-invite flow (unit-tested; no Prisma here).

export type InviteAcceptReason = "ok" | "unverified_preexisting";

/**
 * May this account accept this invite? (review finding S5)
 *
 * The invite token travelled through the invited inbox, so holding it
 * proves control of that email — accepting marks the account's email
 * verified. The one case that proves nothing is an account that already
 * existed before the invite was sent and whose email nobody ever verified:
 * it may have been registered by someone else who guessed the invitee would
 * be invited (the "pre-hijack"). Such an account is refused until its email
 * is verified — today that happens through a password reset (the reset link
 * also goes to the inbox; see `onPasswordReset` in services/auth/better-
 * auth.ts), or by flipping `requireEmailVerification` on, which makes every
 * signed-in account verified by construction.
 *
 * Accounts created after the invite was sent can only have come through the
 * invite's own sign-up (sign-up is otherwise closed), which verifies them;
 * the time check is kept so an older, unverified account can never slip in
 * on a re-sent invite (`createdAt` is the first send — re-inviting updates
 * the row in place).
 */
export function inviteAcceptCheck(args: {
  user: { emailVerified: boolean; createdAt: Date };
  invite: { createdAt: Date };
  requireEmailVerification: boolean;
}): InviteAcceptReason {
  if (args.requireEmailVerification) return "ok";
  if (args.user.emailVerified) return "ok";
  if (args.user.createdAt.getTime() < args.invite.createdAt.getTime()) {
    return "unverified_preexisting";
  }
  return "ok";
}

/**
 * The invite accept URL a sign-up may be bound to: `/join-team?token=…` on
 * a fund host. Returns the token, or null for anything else. Used by the
 * sign-up action: an account can only be created for the email of a live
 * invite whose token the visitor holds.
 */
export function inviteTokenFromReturnTo(returnTo: string | undefined): string | null {
  if (!returnTo) return null;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  if (url.pathname !== "/join-team") return null;
  const token = url.searchParams.get("token");
  return token && token.length > 0 ? token : null;
}
