// SPDX-License-Identifier: AGPL-3.0-or-later
// Logic behind scripts/sync-fund-kind.ts, kept free of Prisma, env parsing
// and network so it can be unit-tested. The script wires in the fund rows and
// the actual GET / PATCH.

import type { TreasuryKind } from "../../services/citizenpay/types";

export type FundKindSyncFund = { domain: string };

/** What `GET /v2/treasury` says about the fund's treasury. */
export type TreasuryKindRead = {
  slug: string | null;
  // null = the api answered without a `kind` (it predates api#260; the PATCH
  // will answer 400 until it is deployed).
  kind: TreasuryKind | null;
};

type Push<F> = (fund: F) => Promise<void>;
type Read<F> = (fund: F) => Promise<TreasuryKindRead>;

/**
 * What the run does for one fund. Every connected fund is a La Caisse fund,
 * so the only write is `kind: "fund"`; a treasury the api already holds as
 * `fund` is left alone, and one that could not be read is reported and not
 * written (the PATCH would most likely fail the same way; the next run
 * covers it).
 */
type Action =
  | { kind: "set"; current: TreasuryKindRead | null }
  | { kind: "already_fund"; current: TreasuryKindRead }
  | { kind: "read_failed"; error: unknown };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function slugText(read: TreasuryKindRead | null): string {
  return read?.slug ? ` [${read.slug}]` : "";
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case "set":
      if (action.current === null) return "set kind=fund (CP not read)";
      if (action.current.kind === null) {
        return `set kind=fund${slugText(action.current)} (api reports no kind — needs api#260)`;
      }
      return `set kind=fund${slugText(action.current)} (now ${action.current.kind})`;
    case "already_fund":
      return `(already fund)${slugText(action.current)}`;
    case "read_failed":
      return `(read failed — ${errorText(action.error)})`;
  }
}

async function actionFor<F extends FundKindSyncFund>(
  fund: F,
  read: Read<F> | undefined,
): Promise<Action> {
  if (!read) return { kind: "set", current: null };
  let current: TreasuryKindRead;
  try {
    current = await read(fund);
  } catch (error) {
    return { kind: "read_failed", error };
  }
  if (current.kind === "fund") return { kind: "already_fund", current };
  return { kind: "set", current };
}

/**
 * Dry run unless `apply`: prints every fund's would-be action. With `apply`,
 * PATCHes `kind: "fund"` on every treasury not already a fund, counting
 * failures (exit 1; a failed read counts and writes nothing). Returns the
 * exit code. `read` is the treasury's current slug + kind; without it every
 * fund is written (the PATCH is idempotent).
 */
export async function runFundKindSync<F extends FundKindSyncFund>(args: {
  funds: F[];
  apply: boolean;
  push: Push<F>;
  read?: Read<F>;
  log?: (line: string) => void;
}): Promise<number> {
  const log = args.log ?? console.log;
  const label = (fund: F, action: Action) =>
    `  ${fund.domain} → ${describeAction(action)}`;

  log(
    `${args.funds.length} connected fund(s)${args.apply ? "" : " — dry run, pass --apply to write"}`,
  );

  let failed = 0;
  for (const fund of args.funds) {
    const action = await actionFor(fund, args.read);
    if (!args.apply) {
      log(label(fund, action));
      continue;
    }
    if (action.kind === "read_failed") {
      failed++;
      log(`${label(fund, action)}: FAILED`);
      continue;
    }
    if (action.kind === "already_fund") {
      log(`${label(fund, action)}: skipped`);
      continue;
    }
    try {
      await args.push(fund);
      log(`${label(fund, action)}: ok`);
    } catch (e) {
      failed++;
      log(`${label(fund, action)}: FAILED ${errorText(e)}`);
    }
  }
  return failed ? 1 : 0;
}
