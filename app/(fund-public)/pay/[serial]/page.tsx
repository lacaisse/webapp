// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowLeft, Info } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { CopyButton } from "@/components/copy-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getBankingStatus } from "@/app/(fund)/bank/data";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { resolveRequestedContribution } from "@/services/member/contribution";
import { buildEpcQrPayload } from "@/services/payment/epc-qr";

// Public, no-auth per-member payment page (see AGENTS.md "(fund-public)"). A
// member reaches it via a link in the cotisation reminder email; `serial` is
// their card's UID. Shows how to pay their monthly contribution by bank
// transfer — beneficiary / IBAN / reference / amount + a scannable EPC QR.
//
// The transfer reference is the card UID (unstructured remittance): CitizenPay
// bank-sync matches the incoming deposit back to this card by serial. The "pay
// with your bank" (Open Banking) flow is intentionally out of scope.

export default async function CotisationPaymentPage({
  params,
}: {
  params: Promise<{ serial: string }>;
}) {
  const fund = await requireCurrentFund();
  const { serial } = await params;

  // serialNumber is globally unique — scope the match to the current fund so a
  // card from another fund can't render on this host. Needs a member (for the
  // greeting + tier); unattached cards 404.
  const card = await prisma.card.findUnique({
    where: { serialNumber: serial },
    select: {
      fundId: true,
      serialNumber: true,
      member: {
        select: {
          firstName: true,
          lastName: true,
          contributionAmount: true,
          tier: { select: { allocationAmount: true } },
        },
      },
    },
  });
  if (!card || card.fundId !== fund.id || !card.member) notFound();

  const t = await getTranslations("cotisation");
  const format = await getFormatter();

  const member = card.member;
  const reference = card.serialNumber;
  const memberName = `${member.firstName} ${member.lastName}`.trim();
  const amount = resolveContributionAmount(member);

  // Beneficiary + IBAN come from the fund's connected bank account — the same
  // banking-status source the admin /bank page displays. Degrades to null when
  // the fund isn't bank-connected yet.
  const banking = await getBankingStatus(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
  );
  const beneficiary = banking.accountName ?? fund.name;
  const iban = banking.accountReference;

  const money = (v: number) =>
    format.number(v, { style: "currency", currency: "EUR" });

  // The QR needs a real IBAN and a positive amount; otherwise we omit it.
  const qrPayload =
    iban && amount != null
      ? buildEpcQrPayload({ beneficiary, iban, amount, reference })
      : null;
  const qrDataUrl = qrPayload
    ? await QRCode.toDataURL(qrPayload, { margin: 1, width: 220 })
    : null;

  return (
    <div className="w-full max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("back")}
        </Link>
        {/* The visitor arrives from an email link with no locale cookie, so
            give them a way to switch language on the page itself. */}
        <LocaleSwitcher />
      </div>

      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t("title")}</CardTitle>
          <CardDescription>
            {t("greeting", { name: memberName })}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {iban ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <dl className="space-y-3">
                <DetailRow label={t("manual.beneficiary")} value={beneficiary} />
                <DetailRow label={t("manual.iban")} value={iban} mono />
                <DetailRow
                  label={t("manual.reference")}
                  value={reference}
                  mono
                />
                {amount != null && (
                  <DetailRow
                    label={t("manual.amount")}
                    value={money(amount)}
                    copyValue={amount.toFixed(2)}
                  />
                )}
              </dl>

              {qrDataUrl && (
                <div className="flex flex-col items-center justify-center gap-3">
                  <h2 className="text-sm font-medium">{t("qr.title")}</h2>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrDataUrl}
                    alt={t("qr.title")}
                    className="rounded-lg bg-white p-2 ring-1 ring-foreground/10"
                    width={220}
                    height={220}
                  />
                  <p className="text-center text-xs text-muted-foreground">
                    {t("qr.hint")}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <dl className="space-y-3">
                <DetailRow
                  label={t("manual.reference")}
                  value={reference}
                  mono
                />
                {amount != null && (
                  <DetailRow
                    label={t("manual.amount")}
                    value={money(amount)}
                    copyValue={amount.toFixed(2)}
                  />
                )}
              </dl>
              <Alert>
                <Info className="size-4" />
                <AlertDescription>
                  {t("notConnected", { fundName: fund.name })}
                </AlertDescription>
              </Alert>
            </div>
          )}

          <Alert variant="warning">
            <Info className="size-4" />
            <AlertDescription>
              {t("manual.referenceNotice", { reference })}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("instructions.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <h3 className="font-medium">{t("instructions.qrTitle")}</h3>
            <p className="text-muted-foreground">{t("instructions.qrBody")}</p>
          </div>
          <div className="space-y-1">
            <h3 className="font-medium">{t("instructions.manualTitle")}</h3>
            <p className="text-muted-foreground">
              {t("instructions.manualBody")}
            </p>
          </div>
          <p className="rounded-lg bg-muted/60 p-3 text-muted-foreground">
            {t("instructions.help", { fundName: fund.name })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// The amount the member should pay: their committed contribution amount when
// set, otherwise the tier's target allocation amount ("montant cible"). Shares
// the same resolution the reminder email uses so the page and the email that
// links to it always request the same figure. Null when neither is known.
function resolveContributionAmount(member: {
  contributionAmount: { toString(): string } | null;
  tier: { allocationAmount: { toString(): string } } | null;
}): number | null {
  const requested = resolveRequestedContribution(
    member.contributionAmount,
    member.tier?.allocationAmount,
  );
  return requested === "" ? null : Number(requested);
}

function DetailRow({
  label,
  value,
  copyValue,
  mono,
}: {
  label: string;
  value: string;
  copyValue?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={mono ? "font-mono font-medium" : "font-medium"}>
          {value}
        </dd>
      </div>
      <CopyButton value={copyValue ?? value} label={label} />
    </div>
  );
}
