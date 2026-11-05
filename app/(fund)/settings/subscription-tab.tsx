// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckCircle2, ExternalLink } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireFundRole } from "@/services/auth/dal";
import { resolveCitizenPayBusinessId } from "@/services/citizenpay/business-id";
import { SUBSCRIPTION_MONTHLY_EUR } from "@/services/fund-setup/config";
import { getCitizenPayDashboardUrls } from "@/services/fund-setup/server";
import { RedeemWaiverForm } from "./redeem-waiver-form";
import { SubscriptionForm } from "./subscription-form";

// Settings → Subscription: the La Caisse hosting plan, and one of: the
// acceptance form plus "Have an invite code?" (OWNER only), an owner-only
// note (other admins), the recorded acceptance with a link to the invoices on
// the Citizen Pay dashboard, or — for a fund whose hosting was waived — the
// waiver and its reason. Accepting is final in the app; so is a waiver.
export async function SubscriptionTab({
  fund,
}: {
  fund: {
    id: string;
    name: string;
    fullName: string | null;
    domain: string;
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
    citizenPayBusinessId: string | null;
    subscriptionAcceptedAt: Date | null;
    subscriptionWaivedAt: Date | null;
    subscriptionWaiverReason: string | null;
    billingLegalName: string | null;
    billingEmail: string | null;
    billingAddress: string | null;
    billingVatNumber: string | null;
  };
}) {
  const { user, membership } = await requireFundRole("ADMIN");
  const isOwner = membership.role === "OWNER";
  const t = await getTranslations("fund.settings.subscription");
  const format = await getFormatter();

  const price = format.number(SUBSCRIPTION_MONTHLY_EUR, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("plan.title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pb-4">
          <p className="font-heading text-3xl font-medium">
            {fund.subscriptionWaivedAt ? t("plan.free") : t("plan.price", { price })}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t("plan.line1")}</li>
            <li>{t("plan.line2")}</li>
            <li>{t("plan.line3")}</li>
          </ul>
          {!fund.subscriptionWaivedAt && (
            <p className="text-sm text-muted-foreground">{t("plan.billing")}</p>
          )}
        </CardContent>
      </Card>

      {fund.subscriptionWaivedAt ? (
        <WaivedCard waivedAt={fund.subscriptionWaivedAt} reason={fund.subscriptionWaiverReason} />
      ) : fund.subscriptionAcceptedAt ? (
        <AcceptedCard fund={fund} acceptedAt={fund.subscriptionAcceptedAt} price={price} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("title")}</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              {isOwner ? (
                <SubscriptionForm
                  fundName={fund.name}
                  defaults={{ legalName: fund.fullName ?? fund.name, email: user.email }}
                  price={price}
                />
              ) : (
                <Alert>
                  <AlertDescription>{t("ownerOnly")}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
          {/* A waiver code (minted by a platform admin) replaces the
              subscription. Same gate as accepting: it settles the fund's
              hosting question, so OWNER only. */}
          {isOwner && (
            <Card>
              <CardHeader>
                <CardTitle>{t("redeem.title")}</CardTitle>
                <CardDescription>{t("redeem.description")}</CardDescription>
              </CardHeader>
              <CardContent className="pb-4">
                <RedeemWaiverForm />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

async function WaivedCard({ waivedAt, reason }: { waivedAt: Date; reason: string | null }) {
  const t = await getTranslations("fund.settings.subscription");
  const format = await getFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-success" />
          {t("waived.title")}
        </CardTitle>
        <CardDescription>
          {t("waived.since", { date: format.dateTime(waivedAt, { dateStyle: "long" }) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        <p className="text-sm">{t("waived.description")}</p>
        {reason && (
          <dl className="rounded-lg border bg-muted/30 p-4 text-sm">
            <div className="flex gap-2">
              <dt className="min-w-32 text-muted-foreground">{t("waived.reason")}</dt>
              <dd>{reason}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

async function AcceptedCard({
  fund,
  acceptedAt,
  price,
}: {
  fund: React.ComponentProps<typeof SubscriptionTab>["fund"];
  acceptedAt: Date;
  price: string;
}) {
  const t = await getTranslations("fund.settings.subscription");
  const format = await getFormatter();
  const invoicesUrl = getCitizenPayDashboardUrls(
    await resolveCitizenPayBusinessId(fund),
  ).billing;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-success" />
          {t("accepted.title")}
        </CardTitle>
        <CardDescription>
          {t("accepted.since", { date: format.dateTime(acceptedAt, { dateStyle: "long" }) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        <p className="text-sm">
          {t("accepted.description", { price, email: fund.billingEmail ?? "—" })}
        </p>
        <dl className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
          <div className="flex gap-2">
            <dt className="min-w-32 text-muted-foreground">{t("form.legalName")}</dt>
            <dd>{fund.billingLegalName ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="min-w-32 text-muted-foreground">{t("form.email")}</dt>
            <dd className="break-all">{fund.billingEmail ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="min-w-32 text-muted-foreground">{t("form.address")}</dt>
            <dd className="whitespace-pre-line">{fund.billingAddress ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="min-w-32 text-muted-foreground">{t("form.vatNumber")}</dt>
            <dd className="font-mono">{fund.billingVatNumber ?? "—"}</dd>
          </div>
        </dl>
        <a
          href={invoicesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline" })}
        >
          <ExternalLink className="size-4" />
          {t("accepted.invoices")}
        </a>
      </CardContent>
    </Card>
  );
}
