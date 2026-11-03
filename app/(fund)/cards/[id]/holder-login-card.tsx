// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Sensitive } from "@/components/privacy/sensitive";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type { CardHolderInfo } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import { DetachHolderButton } from "./detach-holder-button";

// "Holder login" block on the card page (plan "Bread card-holder voting",
// W-2), only for funds with member login on: which member login holds the
// card (the bound member's `userId` + verified email = what the holder sync
// attaches at Citizen Pay), what Citizen Pay itself says — read live in a
// Suspense boundary so a slow api never holds the page —, how the attachment
// was proven (the latest holder CardEvent), a pending wallet claim waiting in
// the /cards inbox, and the Detach for ADMIN behind the step-up.

type HolderMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  userId: string | null;
  emailVerifiedAt: Date | null;
};

const PROOFS = ["app", "bound", "payment", "fund"] as const;
type Proof = (typeof PROOFS)[number];
const isProof = (v: string | null): v is Proof =>
  v !== null && (PROOFS as readonly string[]).includes(v);

export async function HolderLoginCard({
  fund,
  card,
  holderLabel,
  canDetach,
  hasPasskey,
}: {
  fund: FundCredentials;
  card: {
    id: string;
    serialNumber: string;
    memberId: string | null;
    member: HolderMember | null;
  };
  /** For the detach dialog; already masked in privacy mode. */
  holderLabel: string;
  canDetach: boolean;
  hasPasskey: boolean;
}) {
  const t = await getTranslations("cards.admin.holderClaims.card");
  const tProof = await getTranslations("cards.admin.holderClaims.proof");
  const format = await getFormatter();
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

  const [lastHolderEvent, pendingClaim] = await Promise.all([
    // The latest holder event decides: a detachment after the attachment
    // means there is no proof to show any more.
    prisma.cardEvent.findFirst({
      where: {
        cardId: card.id,
        kind: { in: ["HOLDER_ATTACHED", "CLAIM_CONFIRMED", "HOLDER_DETACHED"] },
      },
      orderBy: { at: "desc" },
      select: { at: true, detail: true, kind: true },
    }),
    prisma.cardHolderClaim.findFirst({
      where: { cardId: card.id, status: "PENDING" },
      orderBy: { requestedAt: "desc" },
      select: { id: true },
    }),
  ]);

  const member = card.member;
  const memberName = member
    ? `${member.firstName} ${member.lastName}`.trim()
    : "";
  const hasVerifiedLogin = Boolean(member?.userId && member.emailVerifiedAt);

  let proof: string;
  if (lastHolderEvent && lastHolderEvent.kind !== "HOLDER_DETACHED") {
    // A confirmation from the inbox is the fund's proof even when the row
    // carries no word.
    const word =
      lastHolderEvent.detail ??
      (lastHolderEvent.kind === "CLAIM_CONFIRMED" ? "fund" : null);
    const label = isProof(word) ? tProof(word) : tProof("unknown");
    proof = `${label} · ${when(lastHolderEvent.at)}`;
  } else if (hasVerifiedLogin) {
    // No claim event: the holder sync attached it from the member binding.
    proof = t("assignedHere");
  } else {
    proof = "—";
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <DtDd label={t("login")}>
            {member ? (
              <div className="space-y-1">
                <div>
                  <Link
                    href={`/members/${member.id}`}
                    className="hover:underline"
                  >
                    <Sensitive kind="name">{memberName}</Sensitive>
                  </Link>
                  {member.email && (
                    <div className="text-xs text-muted-foreground">
                      <Sensitive kind="email">{member.email}</Sensitive>
                    </div>
                  )}
                </div>
                {!member.userId ? (
                  <Badge>{t("noLogin")}</Badge>
                ) : member.emailVerifiedAt ? (
                  <Badge variant="success">{t("loginVerified")}</Badge>
                ) : (
                  <Badge variant="warning">{t("loginUnverified")}</Badge>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">{t("noMember")}</span>
            )}
          </DtDd>
          <Suspense
            fallback={
              <DtDd label={t("attached")}>
                <span className="inline-block h-5 w-32 animate-pulse rounded bg-muted" />
              </DtDd>
            }
          >
            <AttachedRow
              fund={fund}
              serialNumber={card.serialNumber}
              memberUserId={member?.userId ?? null}
            />
          </Suspense>
          <DtDd label={t("proof")}>
            <span className={proof === "—" ? "text-muted-foreground" : undefined}>
              {proof}
            </span>
          </DtDd>
        </dl>

        {pendingClaim && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <Hourglass className="size-3.5 text-warning" />
            <span>{t("pendingClaim")}</span>
            <Link href="/cards#holder-claims" className="font-medium underline">
              {t("pendingClaimLink")}
            </Link>
          </div>
        )}

        {member?.userId &&
          (canDetach ? (
            <DetachHolderButton
              cardId={card.id}
              holderLabel={holderLabel}
              hasPasskey={hasPasskey}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
          ))}
      </CardContent>
    </Card>
  );
}

// What Citizen Pay says about the card's holder, read live
// (`GET /v2/treasury/cards/{serial}/holder`). A 404 means the route is not
// deployed yet (or not this fund's card); anything else shows "—".
async function AttachedRow({
  fund,
  serialNumber,
  memberUserId,
}: {
  fund: FundCredentials;
  serialNumber: string;
  memberUserId: string | null;
}) {
  const t = await getTranslations("cards.admin.holderClaims.card");
  const format = await getFormatter();
  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" })
      : "—";

  let info: CardHolderInfo;
  try {
    info = await getCitizenPayClient(fund).getCardHolder(serialNumber);
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 404) {
      return (
        <DtDd label={t("attached")}>
          <span className="text-muted-foreground">{t("notAvailable")}</span>
        </DtDd>
      );
    }
    console.warn("[cards.detail] getCardHolder failed", e);
    return (
      <DtDd label={t("attached")}>
        <span className="text-muted-foreground">—</span>
      </DtDd>
    );
  }

  if (info.holderRef) {
    return (
      <DtDd label={t("attached")}>
        <div className="space-y-1">
          <div>{t("attachedSince", { date: when(info.attachedAt) })}</div>
          {/* The api disagrees with the rows: attached to a login that is
              not the bound member's. */}
          {info.holderRef !== memberUserId && (
            <Badge variant="warning">{t("attachedOther")}</Badge>
          )}
        </div>
      </DtDd>
    );
  }

  if (info.pendingHolderRef) {
    return (
      <DtDd label={t("attached")}>
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <span>{t("claimPending", { date: when(info.pendingSince) })}</span>
          <Link
            href="/cards#holder-claims"
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {t("pendingClaimLink")}
          </Link>
        </span>
      </DtDd>
    );
  }

  return (
    <DtDd label={t("attached")}>
      <span>{t("notAttached")}</span>
    </DtDd>
  );
}

function DtDd({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
