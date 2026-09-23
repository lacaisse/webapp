// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  buildMemberExportCsv,
  memberExportQuestions,
} from "@/services/member/export";
import type { AnswerFormatters } from "@/services/onboarding/format";

// Download every member of the fund as a spreadsheet-ready CSV (issue #206).
// Linked from the Export button on Members.
//
// A route handler rather than a server action because the response IS the
// file: an action would have to ship the whole CSV through the RSC payload
// and have the browser re-wrap it as a blob, and Content-Disposition is what
// makes this a real download. See app/api/payouts/export/route.ts for the
// same reasoning.
//
// OPERATOR-gated to match the /members page itself — member administration is
// an OPERATOR capability (see AGENTS.md) — and fund-scoped by the host:
// requireFundRole resolves the fund from `x-fund-domain`. There's no input to
// spoof; every member of the resolved fund is included.
export async function GET() {
  const { fund } = await requireFundRole("OPERATOR");
  const t = await getTranslations();
  const locale = await getLocale();

  const [members, fields] = await Promise.all([
    prisma.member.findMany({
      where: { fundId: fund.id },
      orderBy: { createdAt: "desc" },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        tier: { select: { name: true } },
        contributionAmount: true,
        address: true,
        postalCode: true,
        city: true,
        paymentReference: true,
        cards: { select: { serialNumber: true } },
        joinedAt: true,
        notes: true,
        applicationData: true,
      },
    }),
    // The fund's custom questions, in form order, archived ones last — the
    // same ordering the member detail page uses. `builtinKey: null` because a
    // built-in question writes to a typed Member column that the fixed
    // columns above already export; its applicationData entry doesn't exist.
    prisma.onboardingField.findMany({
      where: { fundId: fund.id, target: "MEMBER", builtinKey: null },
      orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
      select: { key: true, label: true, type: true, config: true },
    }),
  ]);

  const rows = members.map((m) => ({
    ...m,
    contributionAmount: m.contributionAmount?.toString() ?? null,
    applicationData:
      (m.applicationData as Record<string, unknown> | null) ?? null,
  }));

  // Same injected rendering as the member detail page, minus the date one:
  // a spreadsheet column of dates wants the sortable ISO form the cell
  // already holds, not "15 mars 2026". `joinedAt` above is written the same
  // way for the same reason.
  const answerFormatters: AnswerFormatters = {
    boolean: (v) => (v ? t("common.yes") : t("common.no")),
    date: (v) => v,
  };

  const file = buildMemberExportCsv({
    members: rows,
    questions: memberExportQuestions({ fields, members: rows }),
    fundDomain: fund.domain,
    today: new Date().toISOString().slice(0, 10),
    locale,
    t: (key: string) => t(key as never),
    answerFormatters,
  });

  return new Response(file.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
