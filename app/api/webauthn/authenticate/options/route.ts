import {
  generateAuthenticationOptions,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/services/db/prisma";
import { getRpID } from "@/services/auth/webauthn";

const CHALLENGE_COOKIE = "wa_auth_challenge";
const CHALLENGE_TTL_SECONDS = 5 * 60;

const Body = z.object({
  email: z.email(),
});

export async function POST(request: NextRequest) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) {
    const t = await getTranslations("auth.errors");
    return NextResponse.json({ error: t("emailInvalid") }, { status: 400 });
  }

  // Look up credentials by email. If the user has none, return options with
  // an empty allowCredentials list — the browser will fail with "no
  // credentials available", which is what we want (and gives no info about
  // whether the email exists).
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      webauthnCredentials: {
        select: { credentialId: true, transports: true },
      },
    },
  });

  const allowCredentials =
    user?.webauthnCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })) ?? [];

  const options = await generateAuthenticationOptions({
    rpID: getRpID(),
    allowCredentials,
    userVerification: "preferred",
  });

  const cookieStore = await cookies();
  cookieStore.set(
    CHALLENGE_COOKIE,
    JSON.stringify({
      challenge: options.challenge,
      email: parsed.data.email,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: CHALLENGE_TTL_SECONDS,
    },
  );

  return NextResponse.json(options);
}
