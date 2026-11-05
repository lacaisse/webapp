// SPDX-License-Identifier: AGPL-3.0-or-later
// The public source repository and the links into it the app shows: the
// /source page, and "Report an issue" (components/report-issue-link.tsx),
// which opens GitHub's new-issue form with a body prefilled from the page the
// reporter is on. Pure — no headers, no DB — so client components can use it.

export const REPO_URL = "https://github.com/lacaisse/webapp";

/** The deployed commit when the host tells us (Vercel does); null elsewhere. */
export function getCommitSha(): string | null {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null
  );
}

/**
 * GitHub's new-issue form for the repository, with the body prefilled when
 * given one. Only the body: the reporter writes the title. `URL` does the
 * encoding, so newlines and markdown in the body survive the trip.
 */
export function newIssueUrl(body?: string): string {
  const url = new URL(`${REPO_URL}/issues/new`);
  if (body) url.searchParams.set("body", body);
  return url.toString();
}

/**
 * The prefilled body: a bold prompt per thing we want the reporter to write
 * (with room under each), then a rule and the facts we know — `label: value`
 * lines, skipped when the value is unknown.
 */
export function buildIssueBody(input: {
  prompts: string[];
  facts: { label: string; value: string | null | undefined }[];
}): string {
  const lines: string[] = [];
  for (const prompt of input.prompts) lines.push(`**${prompt}**`, "", "", "");
  const facts = input.facts.filter((f) => f.value);
  if (facts.length > 0) {
    lines.push("---");
    for (const f of facts) lines.push(`${f.label}: ${f.value}`);
  }
  return lines.join("\n");
}
