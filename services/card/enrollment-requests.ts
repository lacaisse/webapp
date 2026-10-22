// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { sendCardAssignedEmailSafe } from "@/services/card/notify";
import { nextCardNumber } from "@/services/card/numbering";
import { scheduleCardHolderNamePublish } from "@/services/card/publish-holder-name";
import { normalizeSerial } from "@/services/card/serial";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CardEnrollmentRequestStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { sendEmail } from "@/services/email/resend";
import { getFundUrl } from "@/services/fund/host";

// Cross-fund card enrollment. A physical card (NFC serial) is issued by one
// fund — the fund holding the original Card row — and other funds may use it
// too. A requesting fund files a CardEnrollmentRequest against the issuer's
// card; the issuer's staff accept or reject it. On accept the REQUESTER fund
// enrolls the serial at CitizenPay with its own API key (POST
// /v2/treasury/cards on an already-issued serial is a silent enrollment, which
// `registerCard` wraps) and gets its own local Card row. Card.serialNumber and
// Card.account are unique per fund, so both rows coexist.

export type ForeignCard = {
  id: string;
  fundId: string;
  serialNumber: string;
  fund: { id: string; name: string; domain: string };
};

/**
 * Card rows for these (already-normalised, see normalizeSerial) serials that
 * live in a fund OTHER than `fundId`. Case-insensitive match. Returns a Map
 * keyed by normalised serial.
 *
 * When several other funds hold the serial (it was already enrolled
 * elsewhere), the issuer's row wins — the one not created by an enrollment —
 * then the oldest.
 */
export async function findForeignCards(
  fundId: string,
  serials: string[],
): Promise<Map<string, ForeignCard>> {
  const wanted = [...new Set(serials.map(normalizeSerial).filter(Boolean))];
  const out = new Map<string, ForeignCard>();
  if (wanted.length === 0) return out;

  const rows = await prisma.card.findMany({
    where: {
      fundId: { not: fundId },
      OR: wanted.map((s) => ({
        serialNumber: { equals: s, mode: "insensitive" as const },
      })),
    },
    select: {
      id: true,
      fundId: true,
      serialNumber: true,
      createdAt: true,
      fund: { select: { id: true, name: true, domain: true } },
      enrolledFromRequest: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Issuer rows (not enrolled from a request) first, oldest first within.
  const ranked = [...rows].sort((a, b) => {
    const ae = a.enrolledFromRequest ? 1 : 0;
    const be = b.enrolledFromRequest ? 1 : 0;
    if (ae !== be) return ae - be;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  for (const r of ranked) {
    const key = normalizeSerial(r.serialNumber);
    if (out.has(key)) continue;
    out.set(key, {
      id: r.id,
      fundId: r.fundId,
      serialNumber: r.serialNumber,
      fund: r.fund,
    });
  }
  return out;
}

export type RequestInput = {
  requesterFund: { id: string; name: string; domain: string };
  requestedById: string;
  card: ForeignCard; // from findForeignCards
  requestedNumber?: number | null;
  memberId?: string | null;
  holderName?: string | null;
};

/**
 * Creates a PENDING request, or revives a REJECTED/CANCELLED one for the same
 * (card, requester fund) back to PENDING with the new details; either way the
 * issuer fund's OWNER/ADMIN staff are then notified by email (fail-soft). An
 * existing PENDING one has its details (requested number, member, holder
 * name, requester) refreshed from this input but is NOT re-notified — the
 * issuer was already told and sees the current details in its /cards inbox.
 */
export async function requestCardEnrollment(
  input: RequestInput,
): Promise<{ id: string; status: CardEnrollmentRequestStatus }> {
  const { requesterFund, card } = input;
  if (card.fundId === requesterFund.id) {
    throw new Error("[card-enrollment] a fund cannot request its own card");
  }

  const details = {
    requestedById: input.requestedById,
    requestedNumber: input.requestedNumber ?? null,
    memberId: input.memberId ?? null,
    holderName: input.holderName?.trim() || null,
  };
  const select = {
    id: true,
    status: true,
    enrolledCardId: true,
  } as const;

  const existing = await prisma.cardEnrollmentRequest.findUnique({
    where: {
      cardId_requesterFundId: { cardId: card.id, requesterFundId: requesterFund.id },
    },
    select,
  });

  let row: { id: string; status: CardEnrollmentRequestStatus };
  if (existing) {
    // PENDING: already waiting on the issuer — refresh its details so the
    // accept honours the latest ask, no second email. Guarded on PENDING so a
    // request decided in between keeps the details it was decided on.
    if (existing.status === "PENDING") {
      try {
        return await prisma.cardEnrollmentRequest.update({
          where: { id: existing.id, status: "PENDING" },
          data: details,
          select: { id: true, status: true },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2025") throw e;
        const now = await prisma.cardEnrollmentRequest.findUnique({
          where: { id: existing.id },
          select: { id: true, status: true },
        });
        if (!now) throw e;
        return now;
      }
    }
    // ACCEPTED with its enrolled card still around: nothing left to ask for.
    if (existing.status === "ACCEPTED" && existing.enrolledCardId) {
      return { id: existing.id, status: existing.status };
    }
    // REJECTED / CANCELLED (or ACCEPTED whose enrolled card was since
    // deleted): ask again with the new details.
    row = await prisma.cardEnrollmentRequest.update({
      where: { id: existing.id },
      data: {
        ...details,
        status: "PENDING",
        decidedById: null,
        decidedAt: null,
        enrolledCardId: null,
      },
      select: { id: true, status: true },
    });
  } else {
    try {
      row = await prisma.cardEnrollmentRequest.create({
        data: {
          ...details,
          cardId: card.id,
          issuerFundId: card.fundId,
          requesterFundId: requesterFund.id,
          status: "PENDING",
        },
        select: { id: true, status: true },
      });
    } catch (e) {
      // Raced with a concurrent request for the same (card, fund): return it.
      if ((e as { code?: string }).code !== "P2002") throw e;
      const raced = await prisma.cardEnrollmentRequest.findUnique({
        where: {
          cardId_requesterFundId: { cardId: card.id, requesterFundId: requesterFund.id },
        },
        select: { id: true, status: true },
      });
      if (!raced) throw e;
      return raced;
    }
  }

  await notifyIssuerStaff(card, requesterFund);
  return row;
}

// Email the issuer fund's OWNER/ADMIN staff that a request is waiting. Never
// throws: a failed lookup, translation or send is logged and swallowed — the
// request itself stands and shows up in the issuer's /cards inbox anyway.
async function notifyIssuerStaff(
  card: ForeignCard,
  requesterFund: { name: string },
): Promise<void> {
  try {
    const staff = await prisma.fundMember.findMany({
      where: { fundId: card.fundId, role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { email: true } } },
    });
    const recipients = [
      ...new Set(staff.map((s) => s.user.email).filter(Boolean)),
    ];
    if (recipients.length === 0) return;

    const t = await getTranslations();
    const subject = t(
      "cards.admin.enrollmentRequest.email.subject" as never,
      { serial: card.serialNumber, requesterFund: requesterFund.name } as never,
    );
    const text = t(
      "cards.admin.enrollmentRequest.email.body" as never,
      {
        serial: card.serialNumber,
        requesterFund: requesterFund.name,
        issuerFund: card.fund.name,
        link: `${getFundUrl(card.fund.domain)}/cards`,
      } as never,
    );

    for (const to of recipients) {
      try {
        await sendEmail({ to, subject, text });
      } catch (e) {
        console.error("[card-enrollment] notify email failed", e);
      }
    }
  } catch (e) {
    console.error("[card-enrollment] notify issuer staff failed", e);
  }
}

export type EnrollmentRequestListItem = {
  id: string;
  status: CardEnrollmentRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  serialNumber: string;
  cardId: string;
  cardNumber: number | null; // issuer card
  issuerFund: { id: string; name: string; domain: string };
  requesterFund: { id: string; name: string; domain: string };
  requestedNumber: number | null;
  holderName: string | null;
  member: { id: string; firstName: string; lastName: string } | null;
  enrolledCardId: string | null;
};

const DECIDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function listRequests(
  side: "issuerFundId" | "requesterFundId",
  fundId: string,
): Promise<EnrollmentRequestListItem[]> {
  const since = new Date(Date.now() - DECIDED_WINDOW_MS);
  const fundSelect = { select: { id: true, name: true, domain: true } } as const;
  const rows = await prisma.cardEnrollmentRequest.findMany({
    where: {
      [side]: fundId,
      OR: [{ status: "PENDING" }, { decidedAt: { gte: since } }],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      decidedAt: true,
      requestedNumber: true,
      holderName: true,
      enrolledCardId: true,
      card: { select: { id: true, serialNumber: true, number: true } },
      issuerFund: fundSelect,
      requesterFund: fundSelect,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const items = rows.map(
    (r): EnrollmentRequestListItem => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      serialNumber: r.card.serialNumber,
      cardId: r.card.id,
      cardNumber: r.card.number,
      issuerFund: r.issuerFund,
      requesterFund: r.requesterFund,
      requestedNumber: r.requestedNumber,
      holderName: r.holderName,
      member: r.member,
      enrolledCardId: r.enrolledCardId,
    }),
  );
  // Pending first (newest request first), then decided (newest decision first).
  const at = (i: EnrollmentRequestListItem) =>
    (i.status === "PENDING" ? i.createdAt : (i.decidedAt ?? i.createdAt)).getTime();
  return items.sort((a, b) => {
    const ap = a.status === "PENDING" ? 0 : 1;
    const bp = b.status === "PENDING" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return at(b) - at(a);
  });
}

/** Incoming = this fund is the issuer; pending first, then decided within the last 30 days, newest first. */
export async function listIncomingRequests(
  fundId: string,
): Promise<EnrollmentRequestListItem[]> {
  return listRequests("issuerFundId", fundId);
}

/** Outgoing = this fund is the requester; same ordering. */
export async function listOutgoingRequests(
  fundId: string,
): Promise<EnrollmentRequestListItem[]> {
  return listRequests("requesterFundId", fundId);
}

export type AcceptResult =
  | { ok: true; enrolledCardId: string }
  | {
      error:
        | "notFound"
        | "notPending"
        | "requesterNotConnected"
        | "failed";
    };

// Thrown inside the accept transaction when the request was decided under us.
class NotPendingError extends Error {}

// The accept transaction can lose a unique race on (fundId, serialNumber) —
// the retry reuses the row that won — or on (fundId, number) when the
// auto-assigned number (max + 1, read outside the tx) was just taken — the
// retry recomputes it.
const MAX_ACCEPT_ATTEMPTS = 3;

/**
 * Issuer side: accept a PENDING request filed against one of this fund's
 * cards. Enrolls the serial at CitizenPay with the REQUESTER fund's
 * credentials (fail-soft, like addCardAction: a CP failure leaves account
 * null), then creates the requester fund's Card row and marks the request
 * ACCEPTED in one transaction. A requested number is honoured even when
 * another requester card holds it (that card is left unnumbered, as the CSV
 * number import does). When this accept binds the card to the request's
 * member, the member gets the CARD_ASSIGNED email, like addCardAction.
 */
export async function acceptCardEnrollmentRequest(args: {
  requestId: string;
  issuerFundId: string;
  decidedById: string;
}): Promise<AcceptResult> {
  const req = await prisma.cardEnrollmentRequest.findFirst({
    where: { id: args.requestId, issuerFundId: args.issuerFundId },
    select: {
      id: true,
      status: true,
      requesterFundId: true,
      requestedNumber: true,
      holderName: true,
      card: { select: { serialNumber: true } },
      member: {
        select: {
          id: true,
          fundId: true,
          email: true,
          firstName: true,
          lastName: true,
          address: true,
          postalCode: true,
          city: true,
        },
      },
    },
  });
  if (!req) return { error: "notFound" };
  if (req.status !== "PENDING") return { error: "notPending" };

  const requesterFund = await prisma.fund.findUnique({
    where: { id: req.requesterFundId },
  });
  if (!requesterFund) return { error: "notFound" };
  if (!requesterFund.citizenPayFundId) return { error: "requesterNotConnected" };

  const serialNumber = req.card.serialNumber; // stored verbatim, as on the issuer card
  // Only bind a member that belongs to the requester fund.
  const member =
    req.member && req.member.fundId === requesterFund.id ? req.member : null;
  const holderName =
    req.holderName?.trim() ||
    (member ? `${member.firstName} ${member.lastName}`.trim() : "") ||
    null;

  const findLocal = () =>
    prisma.card.findFirst({
      where: {
        fundId: requesterFund.id,
        serialNumber: { equals: serialNumber, mode: "insensitive" },
      },
      select: { id: true, memberId: true, account: true },
    });

  // 1. CP enrollment, unless the requester already holds a row for the serial.
  let account: string | null = null;
  if (!(await findLocal())) {
    try {
      const registered = await getCitizenPayClient(requesterFund).registerCard({
        serialNumber,
        fundId: requesterFund.id,
        fundCitizenPayId: requesterFund.citizenPayFundId,
        ...(holderName ? { holderName } : {}),
      });
      account = registered.account;
    } catch (e) {
      console.error("[card-enrollment] registerCard failed during accept", e);
    }
  }

  // 2. Local row + decision, atomically, retried on a lost unique race (see
  // MAX_ACCEPT_ATTEMPTS).
  type Enrolled = {
    card: { id: string; serialNumber: string; number: number | null };
    // This accept bound the card to `member` (vs. reusing a bound row).
    boundMember: boolean;
  };
  const cardSelect = { id: true, serialNumber: true, number: true } as const;
  let enrolled: Enrolled | null = null;
  for (let attempt = 1; attempt <= MAX_ACCEPT_ATTEMPTS && !enrolled; attempt++) {
    try {
      enrolled = await prisma.$transaction(async (tx): Promise<Enrolled> => {
        const existing = await tx.card.findFirst({
          where: {
            fundId: requesterFund.id,
            serialNumber: { equals: serialNumber, mode: "insensitive" },
          },
          select: { ...cardSelect, memberId: true, account: true },
        });

        let result: Enrolled;
        if (existing) {
          const patch: { memberId?: string; holderName?: string | null; account?: string } = {};
          if (member && !existing.memberId) {
            patch.memberId = member.id;
            patch.holderName = holderName;
          }
          if (account && !existing.account) patch.account = account;
          if (Object.keys(patch).length > 0) {
            await tx.card.update({ where: { id: existing.id }, data: patch });
          }
          result = {
            card: {
              id: existing.id,
              serialNumber: existing.serialNumber,
              number: existing.number,
            },
            boundMember: patch.memberId != null,
          };
        } else {
          let number: number;
          if (req.requestedNumber != null) {
            // Honour the requested number: free it from whichever card holds
            // it (left unnumbered — the same displacement the CSV number
            // import does) so the create below can't collide on it.
            const freed = await tx.card.updateMany({
              where: { fundId: requesterFund.id, number: req.requestedNumber },
              data: { number: null },
            });
            if (freed.count > 0) {
              console.info(
                "[card-enrollment] displaced card number",
                requesterFund.id,
                req.requestedNumber,
              );
            }
            number = req.requestedNumber;
          } else {
            number = await nextCardNumber(requesterFund.id);
          }
          const created = await tx.card.create({
            data: {
              fundId: requesterFund.id,
              memberId: member?.id ?? null,
              serialNumber,
              account,
              number,
              holderName,
              status: "INACTIVE", // CP confirms terminal-active separately
              issuedAt: new Date(),
            },
            select: cardSelect,
          });
          result = { card: created, boundMember: member != null };
        }

        const decided = await tx.cardEnrollmentRequest.updateMany({
          where: { id: req.id, status: "PENDING" },
          data: {
            status: "ACCEPTED",
            decidedById: args.decidedById,
            decidedAt: new Date(),
            enrolledCardId: result.card.id,
          },
        });
        if (decided.count !== 1) throw new NotPendingError();
        return result;
      });
    } catch (e) {
      if (e instanceof NotPendingError) return { error: "notPending" };
      // Lost a unique race: retry. The serial case reuses the row that landed
      // in the requester fund; the number case recomputes the next number.
      if ((e as { code?: string }).code === "P2002" && attempt < MAX_ACCEPT_ATTEMPTS) {
        continue;
      }
      console.error("[card-enrollment] accept failed", e);
      return { error: "failed" };
    }
  }
  if (!enrolled) return { error: "failed" };
  const enrolledCardId = enrolled.card.id;

  // 3. registerCard doesn't carry the name — publish it for member-bound cards.
  if (member) scheduleCardHolderNamePublish(requesterFund, enrolledCardId);

  // 4. Same CARD_ASSIGNED email as addCardAction, once committed and only when
  // this accept bound the card to the member. Fail-soft, pause-gated.
  if (member && enrolled.boundMember) {
    await sendCardAssignedEmailSafe({
      fund: requesterFund,
      card: enrolled.card,
      member,
      logTag: "card-enrollment",
    });
  }

  return { ok: true, enrolledCardId };
}

/** Issuer side: reject a PENDING request filed against one of this fund's cards. */
export async function rejectCardEnrollmentRequest(args: {
  requestId: string;
  issuerFundId: string;
  decidedById: string;
}): Promise<{ ok: true } | { error: "notFound" | "notPending" }> {
  const res = await prisma.cardEnrollmentRequest.updateMany({
    where: { id: args.requestId, issuerFundId: args.issuerFundId, status: "PENDING" },
    data: { status: "REJECTED", decidedById: args.decidedById, decidedAt: new Date() },
  });
  if (res.count === 1) return { ok: true };
  return explainMiss({ id: args.requestId, issuerFundId: args.issuerFundId });
}

/** Requester side: withdraw a PENDING request this fund filed. */
export async function cancelCardEnrollmentRequest(args: {
  requestId: string;
  requesterFundId: string;
}): Promise<{ ok: true } | { error: "notFound" | "notPending" }> {
  const res = await prisma.cardEnrollmentRequest.updateMany({
    where: {
      id: args.requestId,
      requesterFundId: args.requesterFundId,
      status: "PENDING",
    },
    data: { status: "CANCELLED", decidedById: null, decidedAt: new Date() },
  });
  if (res.count === 1) return { ok: true };
  return explainMiss({ id: args.requestId, requesterFundId: args.requesterFundId });
}

// A guarded update touched nothing: tell "no such request (for this fund)"
// apart from "already decided".
async function explainMiss(where: {
  id: string;
  issuerFundId?: string;
  requesterFundId?: string;
}): Promise<{ error: "notFound" | "notPending" }> {
  const row = await prisma.cardEnrollmentRequest.findFirst({
    where,
    select: { id: true },
  });
  return { error: row ? "notPending" : "notFound" };
}
