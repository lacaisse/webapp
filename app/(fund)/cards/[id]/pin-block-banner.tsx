// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { ShieldAlert } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Sensitive } from "@/components/privacy/sensitive";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type {
  CardChargeRefusal,
  CardPinEvent,
} from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import { UnblockCardButton } from "./unblock-card-button";

// Banner on the card page while Citizen Pay has the card blocked after three
// wrong PIN entries (D12): where and when it happened (the imported event,
// services/card/pin-block.ts), the Unblock button for ADMIN, and under it
// what the api knows — the card's last PIN events and its refused taps,
// read live (`GET /v2/treasury/cards/{serial}` and `…/refusals`) in a
// Suspense boundary so a slow api never holds the page.

export async function PinBlockBanner({
  fund,
  card,
  holderLabel,
  canUnblock,
  hasPasskey,
}: {
  fund: FundCredentials;
  card: {
    id: string;
    serialNumber: string;
    blockedAt: Date | null;
    placeName: string | null;
  };
  holderLabel: string;
  canUnblock: boolean;
  hasPasskey: boolean;
}) {
  const t = await getTranslations("cards.admin.pinBlock.banner");
  const format = await getFormatter();
  const date = card.blockedAt
    ? format.dateTime(card.blockedAt, { dateStyle: "medium", timeStyle: "short" })
    : null;
  const where =
    card.placeName && date
      ? t("atPlaceOn", { place: card.placeName, date })
      : card.placeName
        ? t("atPlace", { place: card.placeName })
        : date
          ? t("on", { date })
          : null;

  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>
        {t("title")}
        {where ? ` · ${where}` : ""}
      </AlertTitle>
      <AlertDescription>
        <p>{t("description")}</p>
        <div className="mt-2">
          {canUnblock ? (
            <UnblockCardButton
              cardId={card.id}
              holderLabel={holderLabel}
              hasPasskey={hasPasskey}
            />
          ) : (
            <span className="text-xs">{t("adminOnly")}</span>
          )}
        </div>
        <Suspense
          fallback={<p className="mt-3 text-xs opacity-80">{t("loading")}</p>}
        >
          <PinActivity fund={fund} serialNumber={card.serialNumber} />
        </Suspense>
      </AlertDescription>
    </Alert>
  );
}

async function PinActivity({
  fund,
  serialNumber,
}: {
  fund: FundCredentials;
  serialNumber: string;
}) {
  const t = await getTranslations("cards.admin.pinBlock.banner");
  const format = await getFormatter();

  let events: CardPinEvent[] = [];
  let refusals: CardChargeRefusal[] = [];
  try {
    const client = getCitizenPayClient(fund);
    const [detail, refused] = await Promise.all([
      client.getCitizenPayCard(serialNumber),
      client.listCardRefusals(serialNumber, 10),
    ]);
    events = detail?.pinEvents ?? [];
    refusals = refused;
  } catch (e) {
    console.warn("[cards.detail] PIN activity read failed", e);
    return <p className="mt-3 text-xs">{t("loadFailed")}</p>;
  }
  if (events.length === 0 && refusals.length === 0) return null;

  // Place ids → the fund's merchant names; a place of another fund (an
  // enrolled card tapped there) stays an id.
  const placeIds = [
    ...new Set(
      [...events.map((e) => e.placeId), ...refusals.map((r) => r.placeId)].filter(
        (p): p is string => Boolean(p),
      ),
    ),
  ];
  const merchants =
    placeIds.length > 0
      ? await prisma.merchant.findMany({
          where: { fundId: fund.id, citizenPayPlaceId: { in: placeIds } },
          select: { citizenPayPlaceId: true, name: true },
        })
      : [];
  const placeName = (id: string | null) =>
    id ? (merchants.find((m) => m.citizenPayPlaceId === id)?.name ?? id) : null;
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const eur = (cents: number) =>
    format.number(cents / 100, { style: "currency", currency: "EUR" });
  const reasonLabel = (reason: string) =>
    REFUSAL_REASONS.has(reason)
      ? t(`refusals.reason.${reason}` as never)
      : reason;

  return (
    <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
      {events.length > 0 && (
        <div>
          <div className="font-medium">{t("events.title")}</div>
          <ul className="mt-1 space-y-0.5">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {t(`events.action.${e.action}` as never)}
                {" · "}
                {t(`events.by.${e.by}` as never)}
                {e.placeId ? ` · ${placeName(e.placeId)}` : ""}
                {" · "}
                {when(e.at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {refusals.length > 0 && (
        <div>
          <div className="font-medium">{t("refusals.title")}</div>
          <ul className="mt-1 space-y-0.5">
            {refusals.map((r, i) => (
              <li key={`${r.createdAt}-${i}`}>
                {reasonLabel(r.reason)}
                {" · "}
                <Sensitive kind="amount">{eur(r.amountCents)}</Sensitive>
                {r.placeId ? ` · ${placeName(r.placeId)}` : ""}
                {" · "}
                {when(r.createdAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The refusal reasons this build has words for; anything else shows raw.
const REFUSAL_REASONS = new Set([
  "insufficient",
  "source_insufficient",
  "weekly_limit",
  "pin_invalid",
  "pin_blocked",
]);
