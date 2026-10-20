// SPDX-License-Identifier: AGPL-3.0-or-later
// Logic behind scripts/sync-top-up-urls.ts, kept free of Prisma, env parsing
// and network so it can be unit-tested. The script wires in the fund rows and
// the actual GET / PATCH.

import type { AllocationMode } from "../../services/db/generated/enums";
import {
  isOwnTopUpUrl,
  isPublishableTopUpUrl,
  topUpUrlFor,
} from "../../services/citizenpay/top-up-url";

export type TopUpUrlSyncFund = {
  domain: string;
  allocationMode: AllocationMode;
};

type Push<F> = (fund: F, url: string | null) => Promise<void>;
type Read<F> = (fund: F) => Promise<string | null>;

/**
 * What the run does for one fund. A computed link is always set; a computed
 * null (DISABLED) only clears a link La Caisse published itself
 * (isOwnTopUpUrl) — a CP-managed value such as CP's own checkout is left.
 */
type Action =
  | { kind: "set"; url: string }
  | { kind: "clear" }
  | { kind: "leave"; current: string }
  | { kind: "already_clear" }
  | { kind: "not_read" }
  | { kind: "read_failed"; error: unknown };

/**
 * The URL this environment would build for a stock PAY_AND_GO fund. Checked
 * before touching the DB: anything but https means NODE_ENV / APP_DOMAIN
 * aren't set for production.
 */
export function probeTopUpUrl(): string | null {
  return topUpUrlFor({ domain: "probe.lacaisse.eu", allocationMode: "PAY_AND_GO" });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function describeAction(action: Action): string {
  switch (action.kind) {
    case "set":
      return action.url;
    case "clear":
      return "(clear)";
    case "leave":
      return `(leave: CP-managed URL) ${action.current}`;
    case "already_clear":
      return "(already clear)";
    case "not_read":
      return "(clear only if it's our own link — CP not read)";
    case "read_failed":
      return `(leave: read failed — ${errorText(action.error)})`;
  }
}

async function actionFor<F extends TopUpUrlSyncFund>(
  fund: F,
  read: Read<F> | undefined,
): Promise<Action> {
  const url = topUpUrlFor(fund);
  if (url !== null) return { kind: "set", url };
  if (!read) return { kind: "not_read" };
  let current: string | null;
  try {
    current = await read(fund);
  } catch (error) {
    return { kind: "read_failed", error };
  }
  if (current === null) return { kind: "already_clear" };
  return isOwnTopUpUrl(fund, current) ? { kind: "clear" } : { kind: "leave", current };
}

/**
 * Dry run unless `apply`: prints every fund's would-be action. With `apply`,
 * refuses to write anything (exit 2) if any computed URL isn't https or no
 * `read` is wired, then sets each link / clears each own stale link,
 * counting failures (exit 1; a failed read counts and clears nothing).
 * Returns the exit code. `read` is the treasury's current top-up URL, only
 * consulted for funds that compute null.
 */
export async function runTopUpUrlSync<F extends TopUpUrlSyncFund>(args: {
  funds: F[];
  apply: boolean;
  push: Push<F>;
  read?: Read<F>;
  log?: (line: string) => void;
}): Promise<number> {
  const log = args.log ?? console.log;
  const label = (fund: F, action: Action) =>
    `  ${fund.domain} [${fund.allocationMode}] → ${describeAction(action)}`;

  log(`${args.funds.length} connected fund(s)${args.apply ? "" : " — dry run, pass --apply to write"}`);

  const insecure = args.funds.filter((f) => !isPublishableTopUpUrl(topUpUrlFor(f)));
  if (args.apply && insecure.length) {
    log("Refusing to write: non-https top-up URLs (set NODE_ENV=production APP_DOMAIN=lacaisse.eu):");
    for (const f of insecure) log(`  ${f.domain} [${f.allocationMode}] → ${topUpUrlFor(f)}`);
    return 2;
  }
  if (args.apply && !args.read) {
    log("Refusing to write: no treasury reader — a clear must check the current URL first.");
    return 2;
  }

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
    if (action.kind !== "set" && action.kind !== "clear") {
      log(`${label(fund, action)}: skipped`);
      continue;
    }
    try {
      await args.push(fund, action.kind === "set" ? action.url : null);
      log(`${label(fund, action)}: ok`);
    } catch (e) {
      failed++;
      log(`${label(fund, action)}: FAILED ${errorText(e)}`);
    }
  }
  if (!args.apply && insecure.length) {
    log(`  ! ${insecure.length} non-https URL(s): --apply would refuse (set NODE_ENV=production APP_DOMAIN=lacaisse.eu)`);
  }
  return failed ? 1 : 0;
}
