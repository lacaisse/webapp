// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Sensitive } from "@/components/privacy/sensitive";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { maskValue } from "@/lib/privacy";
import {
  type CardHolderClaimListItem,
  listCardHolderClaims,
} from "@/services/card/holder-claims";
import type { CardHolderClaimStatus } from "@/services/db/generated/enums";
import { getPrivacyMode } from "@/services/privacy/server";

import { HolderClaimActions } from "./holder-claim-actions";

// Claims from the card wallet (plan "Bread card-holder voting", W-2): a
// holder claimed one of this fund's cards with their member login and Citizen
// Pay could not settle it on its own, so the fund decides — Confirm attaches
// the card to that login, Refuse leaves it public. Pending rows first, then
// anything decided in the last 30 days (listCardHolderClaims). Renders
// nothing when empty, which is the common case. A claim by a login that is
// not a member here is shown but never confirmable.

const PROOFS = new Set(["treasury", "fund", "payment", "confirmed", "pending"]);

export async function HolderClaimsPanel({ fundId }: { fundId: string }) {
  const claims = await listCardHolderClaims(fundId);
  if (claims.length === 0) return null;

  const t = await getTranslations("fund.cards.holderClaims");
  const tProof = await getTranslations("cards.admin.holderClaims.proof");
  const format = await getFormatter();
  const privacy = await getPrivacyMode();

  const proofLabel = (proof: string | null) =>
    proof && PROOFS.has(proof)
      ? tProof(proof as "treasury" | "fund" | "payment" | "confirmed" | "pending")
      : tProof("unknown");
  const nameOf = (c: CardHolderClaimListItem) =>
    c.member ? `${c.member.firstName} ${c.member.lastName}`.trim() : "";

  return (
    <section
      id="holder-claims"
      aria-label={t("anchor")}
      className="scroll-mt-6 space-y-2"
    >
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.serial")}</TableHead>
            <TableHead>{t("columns.number")}</TableHead>
            <TableHead>{t("columns.member")}</TableHead>
            <TableHead>{t("columns.proof")}</TableHead>
            <TableHead>{t("columns.requested")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {claims.map((c) => {
            const name = nameOf(c);
            return (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">
                  {c.cardId ? (
                    <Link href={`/cards/${c.cardId}`} className="hover:underline">
                      <Sensitive kind="number">{c.serial}</Sensitive>
                    </Link>
                  ) : (
                    <Sensitive kind="number">{c.serial}</Sensitive>
                  )}
                </TableCell>
                <TableCell className="tabular-nums text-sm text-muted-foreground">
                  {c.cardNumber !== null ? (
                    <Sensitive kind="number">{String(c.cardNumber)}</Sensitive>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {c.member ? (
                    <div className="space-y-0.5">
                      <Link
                        href={`/members/${c.member.id}`}
                        className="text-sm hover:underline"
                      >
                        <Sensitive kind="name">{name}</Sensitive>
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        <Sensitive kind="email">{c.member.email}</Sensitive>
                      </div>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t("notMember")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {proofLabel(c.proof)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(c.requestedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} label={t(`status.${c.status}`)} />
                </TableCell>
                <TableCell className="text-right">
                  {c.status === "PENDING" && c.member && (
                    <HolderClaimActions
                      claimId={c.id}
                      // Dialog copy is a plain string: mask it here.
                      serial={privacy ? maskValue("number") : c.serial}
                      memberName={privacy ? maskValue("name") : name}
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function StatusBadge({
  status,
  label,
}: {
  status: CardHolderClaimStatus;
  label: string;
}) {
  if (status === "PENDING") return <Badge variant="outline">{label}</Badge>;
  if (status === "CONFIRMED" || status === "ATTACHED") {
    return <Badge variant="success">{label}</Badge>;
  }
  return <Badge>{label}</Badge>;
}
