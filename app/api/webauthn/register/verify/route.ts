import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getTranslations } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { getExpectedOrigin, getRpID } from "@/services/auth/webauthn";

const CHALLENGE_COOKIE = "wa_reg_challenge";

type RegisterVerifyBody = {
  response: RegistrationResponseJSON;
  nickname?: string;
};

export async function POST(request: NextRequest) {
  const t = await getTranslations("auth.errors");
  const user = await requireUser();
  const body = (await request.json()) as RegisterVerifyBody;

  const cookieStore = await cookies();
  const expectedChallenge = cookieStore.get(CHALLENGE_COOKIE)?.value;
  if (!expectedChallenge) {
    return NextResponse.json(
      { error: t("sessionExpired") },
      { status: 400 },
    );
  }
  cookieStore.delete(CHALLENGE_COOKIE);

  const requestOrigin = (await headers()).get("origin");

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(requestOrigin),
      expectedRPID: getRpID(),
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json(
      { error: t("passkeyVerifyFailed") },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json(
      { error: t("passkeyVerifyFailed") },
      { status: 400 },
    );
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  await prisma.webAuthnCredential.create({
    data: {
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname: body.nickname?.trim() || null,
    },
  });

  return NextResponse.json({ ok: true });
}
