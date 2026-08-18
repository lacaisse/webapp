// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import { CopyButton } from "@/components/copy-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/services/db/prisma";
import { getFundUrl } from "@/services/fund/server";
import { EmbedAccounts, type EmbedAccountRow } from "./embed-accounts";
import { EmbedDomainsForm } from "./embed-domains-form";
import { EMBED_HEIGHTS, buildEmbedSnippet } from "./embed-snippet";

// Embeds tab: the allowlist that decides where the widgets may be framed, the
// per-account switches for the account widget, and the copy-paste snippets.
//
// The allowlist card comes first deliberately — with no domains configured the
// CSP is `frame-ancestors 'none'` and nothing renders anywhere, so it's the
// step that has to happen before any snippet is worth copying.

export async function EmbedsTab({
  fund,
}: {
  fund: {
    id: string;
    name: string;
    domain: string;
    embedAllowedDomains: string[];
  };
}) {
  const t = await getTranslations("fund.settings.embeds");

  const accounts = await prisma.fundTokenAccount.findMany({
    where: { fundId: fund.id, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, embedSlug: true },
  });

  const baseUrl = getFundUrl(fund.domain);

  // The merchant widgets need no per-fund handle: what they show is already the
  // fund's public directory, so the snippet is the same for every visitor and
  // can be rendered here rather than minted.
  const merchantsSnippet = buildEmbedSnippet(
    `${baseUrl}/embed/merchants`,
    `${fund.name} — ${t("merchants.listTitle")}`,
    EMBED_HEIGHTS.merchants,
  );
  const mapSnippet = buildEmbedSnippet(
    `${baseUrl}/embed/merchants/map`,
    `${fund.name} — ${t("merchants.mapTitle")}`,
    EMBED_HEIGHTS.map,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("domains.title")}</CardTitle>
          <CardDescription>{t("domains.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmbedDomainsForm initialDomains={fund.embedAllowedDomains} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("accounts.title")}</CardTitle>
          <CardDescription>{t("accounts.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmbedAccounts
            accounts={accounts as EmbedAccountRow[]}
            baseUrl={baseUrl}
            fundName={fund.name}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("merchants.title")}</CardTitle>
          <CardDescription>{t("merchants.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pb-4">
          <SnippetBlock
            label={t("merchants.listSnippetLabel")}
            snippet={merchantsSnippet}
          />
          <SnippetBlock
            label={t("merchants.mapSnippetLabel")}
            snippet={mapSnippet}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function SnippetBlock({
  label,
  snippet,
}: {
  label: string;
  snippet: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex items-start gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs break-all whitespace-pre-wrap">
          {snippet}
        </code>
        <CopyButton value={snippet} />
      </div>
    </div>
  );
}
