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
  type EnrollmentRequestListItem,
  listIncomingRequests,
  listOutgoingRequests,
} from "@/services/card/enrollment-requests";
import type { CardEnrollmentRequestStatus } from "@/services/db/generated/enums";
import { getPrivacyMode } from "@/services/privacy/server";

import {
  IncomingRequestActions,
  OutgoingRequestActions,
} from "./enrollment-request-actions";

// Cross-fund card enrollment requests, above the cards table. Incoming: other
// funds asking to use a card this fund issued (accept / reject). Outgoing:
// cards this fund asked another fund for (cancel while pending). Pending rows
// first, then anything decided in the last 30 days. Renders nothing when both
// lists are empty, which is the common case.

export async function CardEnrollmentRequestsPanel({
  fundId,
}: {
  fundId: string;
}) {
  const [incoming, outgoing] = await Promise.all([
    listIncomingRequests(fundId),
    listOutgoingRequests(fundId),
  ]);
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const t = await getTranslations("fund.cards.enrollmentRequests");
  const format = await getFormatter();
  const privacy = await getPrivacyMode();

  const dateOf = (r: EnrollmentRequestListItem) =>
    format.dateTime(r.createdAt, { dateStyle: "medium" });
  // Dialog copy is a plain string, so mask the serial here; rendered cells
  // use <Sensitive>.
  const serialText = (r: EnrollmentRequestListItem) =>
    privacy ? maskValue("number") : r.serialNumber;
  // Detail lines are built as strings (ICU args can't carry <Sensitive>), so
  // personal values are masked here when privacy mode is on.
  //
  // The member is the REQUESTER fund's record: only the requester's own
  // (outgoing) rows show it. The issuer (incoming rows) sees the holder name —
  // what gets published to CitizenPay as the card profile — and the number.
  const detailLines = (
    r: EnrollmentRequestListItem,
    side: "incoming" | "outgoing",
  ) => {
    const memberName =
      side === "outgoing" && r.member
        ? `${r.member.firstName} ${r.member.lastName}`.trim()
        : "";
    const lines: string[] = [];
    if (memberName) {
      lines.push(
        t("forMember", { name: privacy ? maskValue("name") : memberName }),
      );
    }
    if (r.holderName && r.holderName !== memberName) {
      lines.push(
        t("holder", { name: privacy ? maskValue("name") : r.holderName }),
      );
    }
    if (r.requestedNumber !== null) {
      lines.push(
        t("requestedNumber", {
          number: privacy ? maskValue("number") : String(r.requestedNumber),
        }),
      );
    }
    return lines;
  };

  return (
    <div className="space-y-6">
      {incoming.length > 0 && (
        <section className="space-y-2">
          <div className="space-y-0.5">
            <h2 className="text-sm font-medium">{t("incomingTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("incomingDescription")}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.serial")}</TableHead>
                <TableHead>{t("columns.number")}</TableHead>
                <TableHead>{t("columns.fund")}</TableHead>
                <TableHead>{t("columns.details")}</TableHead>
                <TableHead>{t("columns.requested")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {incoming.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/cards/${r.cardId}`} className="hover:underline">
                      <Sensitive kind="number">{r.serialNumber}</Sensitive>
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums text-sm text-muted-foreground">
                    {r.cardNumber !== null ? (
                      <Sensitive kind="number">{String(r.cardNumber)}</Sensitive>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{r.requesterFund.name}</TableCell>
                  <TableCell>
                    <RequestDetails lines={detailLines(r, "incoming")} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dateOf(r)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={r.status}
                      label={t(`status.${r.status}`)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "PENDING" && (
                      <IncomingRequestActions
                        requestId={r.id}
                        serial={serialText(r)}
                        fundName={r.requesterFund.name}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {outgoing.length > 0 && (
        <section className="space-y-2">
          <div className="space-y-0.5">
            <h2 className="text-sm font-medium">{t("outgoingTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("outgoingDescription")}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.serial")}</TableHead>
                <TableHead>{t("columns.fund")}</TableHead>
                <TableHead>{t("columns.details")}</TableHead>
                <TableHead>{t("columns.requested")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {outgoing.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    {/* The issuer's card lives in another fund, so there is
                        nothing local to link to until it is accepted. */}
                    {r.status === "ACCEPTED" && r.enrolledCardId ? (
                      <Link
                        href={`/cards/${r.enrolledCardId}`}
                        className="hover:underline"
                      >
                        <Sensitive kind="number">{r.serialNumber}</Sensitive>
                      </Link>
                    ) : (
                      <Sensitive kind="number">{r.serialNumber}</Sensitive>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{r.issuerFund.name}</TableCell>
                  <TableCell>
                    <RequestDetails lines={detailLines(r, "outgoing")} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {dateOf(r)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={r.status}
                      label={t(`status.${r.status}`)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "PENDING" ? (
                      <OutgoingRequestActions
                        requestId={r.id}
                        serial={serialText(r)}
                        fundName={r.issuerFund.name}
                      />
                    ) : r.status === "ACCEPTED" && r.enrolledCardId ? (
                      <Link
                        href={`/cards/${r.enrolledCardId}`}
                        className="text-sm hover:underline"
                      >
                        {t("viewCard")}
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}

// Member (outgoing only) / holder / requested number, one per line; "—" when
// none was given.
function RequestDetails({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="space-y-0.5 text-sm text-muted-foreground">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

function StatusBadge({
  status,
  label,
}: {
  status: CardEnrollmentRequestStatus;
  label: string;
}) {
  if (status === "PENDING") return <Badge variant="outline">{label}</Badge>;
  if (status === "ACCEPTED") return <Badge variant="success">{label}</Badge>;
  return <Badge>{label}</Badge>;
}
