// SPDX-License-Identifier: AGPL-3.0-or-later
// Logic behind scripts/register-events-webhooks.ts, kept free of Prisma, env
// parsing and network so it can be unit-tested. The script wires in the fund
// rows and the actual secret handling + PATCH.

import {
  eventsWebhookUrlFor,
  isPublishableEventsWebhookUrl,
} from "../../services/citizenpay/events-webhook-url";

export type EventsWebhookSyncFund = {
  domain: string;
  citizenPayEventsWebhookRegisteredAt: Date | null;
  citizenPayEventsWebhookError: string | null;
};

type Register<F> = (fund: F, url: string) => Promise<void>;

/**
 * What the run does for one fund: register the webhook when the fund never
 * had one registered (or its last registration failed), skip a fund whose
 * registration is on record — unless `force`, which re-registers every fund
 * (the url is rebuilt from the current domain and the stored secret is
 * re-sent, so a moved fund gets its new url).
 */
type Action =
  | { kind: "register"; url: string; why: "never" | "failed" | "forced" }
  | { kind: "skip"; registeredAt: Date };

/**
 * The url this environment would build for a stock fund. Checked before
 * touching the DB: anything but https means NODE_ENV / APP_DOMAIN aren't set
 * for production, and the api refuses non-https urls anyway.
 */
export function probeEventsWebhookUrl(): string {
  return eventsWebhookUrlFor({ domain: "probe.lacaisse.eu" });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function actionFor<F extends EventsWebhookSyncFund>(fund: F, force: boolean): Action {
  const url = eventsWebhookUrlFor(fund);
  if (force) return { kind: "register", url, why: "forced" };
  if (fund.citizenPayEventsWebhookRegisteredAt === null) {
    return { kind: "register", url, why: fund.citizenPayEventsWebhookError ? "failed" : "never" };
  }
  return { kind: "skip", registeredAt: fund.citizenPayEventsWebhookRegisteredAt };
}

function describe(action: Action): string {
  switch (action.kind) {
    case "register":
      return `${action.url} (${action.why === "never" ? "never registered" : action.why === "failed" ? "last registration failed" : "forced"})`;
    case "skip":
      return `(already registered ${action.registeredAt.toISOString().slice(0, 10)})`;
  }
}

/**
 * Dry run unless `apply`: prints every fund's would-be action. With `apply`,
 * refuses to write anything (exit 2) if the environment builds a non-https
 * url, then registers each fund that needs it, counting failures (exit 1).
 * Returns the exit code.
 */
export async function runEventsWebhookSync<F extends EventsWebhookSyncFund>(args: {
  funds: F[];
  apply: boolean;
  force?: boolean;
  register: Register<F>;
  log?: (line: string) => void;
}): Promise<number> {
  const log = args.log ?? console.log;
  const force = args.force ?? false;
  const label = (fund: F, action: Action) => `  ${fund.domain} → ${describe(action)}`;

  log(
    `${args.funds.length} connected fund(s)${args.apply ? "" : " — dry run, pass --apply to write"}${force ? ", --force: every fund is re-registered" : ""}`,
  );

  const probe = probeEventsWebhookUrl();
  if (args.apply && !isPublishableEventsWebhookUrl(probe)) {
    log(`Refusing to write: this environment builds ${probe} (set NODE_ENV=production APP_DOMAIN=lacaisse.eu).`);
    return 2;
  }

  let failed = 0;
  for (const fund of args.funds) {
    const action = actionFor(fund, force);
    if (!args.apply) {
      log(label(fund, action));
      continue;
    }
    if (action.kind === "skip") {
      log(`${label(fund, action)}: skipped`);
      continue;
    }
    try {
      await args.register(fund, action.url);
      log(`${label(fund, action)}: ok`);
    } catch (e) {
      failed++;
      log(`${label(fund, action)}: FAILED ${errorText(e)}`);
    }
  }
  if (!args.apply && !isPublishableEventsWebhookUrl(probe)) {
    log(`  ! non-https url: --apply would refuse (set NODE_ENV=production APP_DOMAIN=lacaisse.eu)`);
  }
  return failed ? 1 : 0;
}
