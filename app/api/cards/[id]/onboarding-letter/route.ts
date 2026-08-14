// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NextRequest } from "next/server";

import { requireFundRole } from "@/services/auth/dal";
import { resolveDocumentTemplate } from "@/services/document/templates";
import { renderDocumentPdf } from "@/services/document/pdf";
import { prisma } from "@/services/db/prisma";

// Download the card onboarding letter (the "invite") as a PDF. Admin-gated,
// fund-scoped. The letter wording is the fund's editable CARD_ONBOARDING_LETTER
// document template (or the built-in default); the dynamic {{tokens}} come from
// the card's member. Linked from the card detail page.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { fund } = await requireFundRole("OPERATOR");
  const { id } = await params;

  const card = await prisma.card.findFirst({
    where: { id, fundId: fund.id },
    select: {
      id: true,
      number: true,
      serialNumber: true,
      member: {
        select: { firstName: true, lastName: true },
      },
    },
  });
  if (!card) {
    return new Response("Card not found", { status: 404 });
  }
  if (!card.member) {
    return new Response("Card is not assigned to a member", { status: 400 });
  }

  const body = await resolveDocumentTemplate({
    fundId: fund.id,
    type: "CARD_ONBOARDING_LETTER",
    vars: {
      fund_name: fund.name,
      full_name: fund.fullName?.trim() || fund.name,
      website: fund.websiteUrl ?? "",
      first_name: card.member.firstName,
      last_name: card.member.lastName,
      card_number: card.number != null ? String(card.number) : "",
      // The payment reference is the card's UID (serialNumber) — the same value
      // the public /pay/[serial] page and CitizenPay bank-sync match on (#111).
      payment_reference: card.serialNumber ?? "",
    },
  });

  const pdf = await renderDocumentPdf(body, {
    fundName: fund.name,
    fullName: fund.fullName,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${onboardingFileName(card)}"`,
      "Cache-Control": "no-store",
    },
  });
}

// A safe, descriptive download name: invitation-<number>-<lastname>.pdf,
// stripped to ASCII word chars so no header-encoding surprises.
function onboardingFileName(card: {
  number: number | null;
  member: { lastName: string } | null;
}): string {
  const parts = ["invitation"];
  if (card.number != null) parts.push(String(card.number));
  const last = card.member?.lastName
    ?.normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (last) parts.push(last.toLowerCase());
  return `${parts.join("-")}.pdf`;
}
