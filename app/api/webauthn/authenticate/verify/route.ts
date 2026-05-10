import {
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/services/auth/admin";
import { createSupabaseServerClient } from "@/services/auth/server";
import { buildLoginRedirect } from "@/services/auth/post-login";
import { getExpectedOrigin, getRpID } from "@/services/auth/webauthn";
import { prisma } from "@/services/db/prisma";

const CHALLENGE_COOKIE = "wa_auth_challenge";

type AuthVerifyBody = {
  response: AuthenticationResponseJSON;
  returnTo?: string;
};

export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.errors");
  const body = (await request.json()) as AuthVerifyBody;

  const cookieStore = await cookies();
  const raw = cookieStore.get(CHALLENGE_COOKIE)?.value;
  if (!raw) {
    return NextResponse.json(
      { error: t("sessionExpired") },
      { status: 400 },
    );
  }
  cookieStore.delete(CHALLENGE_COOKIE);

  let session: { challenge: string; email: string };
  try {
    session = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: t("sessionExpired") },
      { status: 400 },
    );
  }

  // Look up the credential the authenticator says it used.
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: body.response.id },
    include: { user: true },
  });
  if (!credential || credential.user.email !== session.email) {
    // Don't leak whether the credential exists or whether it belongs to
    // someone else — just say it failed.
    return NextResponse.json(
      { error: t("signInFailed") },
      { status: 401 },
    );
  }

  const requestOrigin = (await headers()).get("origin");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: session.challenge,
      expectedOrigin: getExpectedOrigin(requestOrigin),
      expectedRPID: getRpID(),
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
    });
  } catch {
    return NextResponse.json({ error: t("signInFailed") }, { status: 401 });
  }

  if (!verification.verified) {
    return NextResponse.json({ error: t("signInFailed") }, { status: 401 });
  }

  // Update counter + lastUsedAt. The counter is the authenticator's monotonic
  // signature counter — useful for cloned-authenticator detection.
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });

  // ===========================================================================
  // Bridge to Supabase session
  // ===========================================================================
  // We've authenticated the user via WebAuthn, but Supabase doesn't know.
  // Pattern: ask Supabase to mint a magic-link OTP for this email, then
  // immediately verify it server-side. The SSR client writes the resulting
  // session cookies onto the response.

  const admin = createSupabaseAdminClient();
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: credential.user.email,
    });
  if (linkError || !linkData.properties?.email_otp) {
    return NextResponse.json(
      { error: t("establishSessionFailed") },
      { status: 500 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error: otpError } = await supabase.auth.verifyOtp({
    email: credential.user.email,
    token: linkData.properties.email_otp,
    type: "email",
  });
  if (otpError) {
    return NextResponse.json(
      { error: t("establishSessionFailed") },
      { status: 500 },
    );
  }

  // Auth-host session is now live. Mint a single-use exchange code targeted
  // at the destination host (validated `returnTo` or the apex by default) so
  // the client can hand off via /auth/handoff and obtain per-host cookies.
  const { url: redirectTo } = await buildLoginRedirect({
    userId: credential.user.id,
    email: credential.user.email,
    returnTo: body.returnTo,
  });

  return NextResponse.json({ ok: true, redirectTo });
}
