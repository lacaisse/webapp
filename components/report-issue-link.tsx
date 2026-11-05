// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { MessageSquareWarning } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { buildIssueBody, newIssueUrl } from "@/lib/repo";

// "Report an issue": GitHub's new-issue form for the public repository, in a
// new tab, with the body prefilled — two prompts for the reporter to answer,
// then where it happened: the page they are on and the deployed version. The
// page is `origin` (the host's public URL, known to the server) plus the
// client router's pathname, so the href is complete in the server HTML and
// follows every client-side navigation; the query string is left out. The
// reporter sees and edits the body before anything is posted.
export function ReportIssueLink({
  origin,
  version,
  className,
}: {
  origin: string;
  version: string | null;
  className?: string;
}) {
  const t = useTranslations("reportIssue");
  const pathname = usePathname();

  const href = newIssueUrl(
    buildIssueBody({
      prompts: [t("whatHappened"), t("expected")],
      facts: [
        { label: t("page"), value: `${origin}${pathname}` },
        { label: t("version"), value: version },
      ],
    }),
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      <MessageSquareWarning className="size-4" />
      {t("label")}
    </a>
  );
}
