// SPDX-License-Identifier: AGPL-3.0-or-later
// Logic behind scripts/sync-top-up-urls.ts, kept free of Prisma, env parsing
// and network so it can be unit-tested. The script wires in the fund rows and
// the actual PATCH.

import type { AllocationMode } from "../../services/db/generated/enums";
import {
  isPublishableTopUpUrl,
  topUpUrlFor,
} from "../../services/citizenpay/top-up-url";

export type TopUpUrlSyncFund = {
  domain: string;
  allocationMode: AllocationMode;
};

type Push<F> = (fund: F, url: string | null) => Promise<void>;

/**
 * The URL this environment would build for a stock PAY_AND_GO fund. Checked
 * before touching the DB: anything but https means NODE_ENV / APP_DOMAIN
 * aren't set for production.
 */
export function probeTopUpUrl(): string | null {
  return topUpUrlFor({ domain: "probe.lacaisse.eu", allocationMode: "PAY_AND_GO" });
}

/**
 * Dry run unless `apply`: prints every fund's would-be URL. With `apply`,
 * refuses to write anything (exit 2) if any computed URL isn't https, then
 * pushes each one, counting failures (exit 1). Returns the exit code.
 */
export async function runTopUpUrlSync<F extends TopUpUrlSyncFund>(args: {
  funds: F[];
  apply: boolean;
  push: Push<F>;
  log?: (line: string) => void;
}): Promise<number> {
  const log = args.log ?? console.log;
  const plan = args.funds.map((fund) => ({ fund, url: topUpUrlFor(fund) }));
  const label = (p: (typeof plan)[number]) =>
    `  ${p.fund.domain} [${p.fund.allocationMode}] → ${p.url ?? "(clear)"}`;

  log(`${plan.length} connected fund(s)${args.apply ? "" : " — dry run, pass --apply to write"}`);

  const insecure = plan.filter((p) => !isPublishableTopUpUrl(p.url));
  if (!args.apply) {
    for (const p of plan) log(label(p));
    if (insecure.length) {
      log(`  ! ${insecure.length} non-https URL(s): --apply would refuse (set NODE_ENV=production APP_DOMAIN=lacaisse.eu)`);
    }
    return 0;
  }
  if (insecure.length) {
    log("Refusing to write: non-https top-up URLs (set NODE_ENV=production APP_DOMAIN=lacaisse.eu):");
    for (const p of insecure) log(label(p));
    return 2;
  }

  let failed = 0;
  for (const p of plan) {
    try {
      await args.push(p.fund, p.url);
      log(`${label(p)}: ok`);
    } catch (e) {
      failed++;
      log(`${label(p)}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed ? 1 : 0;
}
