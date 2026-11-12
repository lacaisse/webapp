// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { cronGate } from "@/services/cron/guard";
import { reencryptStep } from "@/services/crypto/reencrypt";

// APP_CRED_KEY rotation step for the self-hosted platform
// (docs/container.md): `POST` with the cron bearer re-encrypts at most one
// batch of cells sealed under APP_CRED_KEY_PREVIOUS and answers
// `{"done": bool, "reencrypted": int, "remaining": int}`. The rotation
// recipe calls it until `done` is true, then drops the previous key.
//
// Guarded exactly like the cron routes (services/cron/guard.ts); outside
// production, where a cron route answers 200 `{"skipped": …}`, this one
// answers 503 so a caller waiting for `done` never mistakes it for progress.
// Any answer other than 200 means "not done, look at the app's log": 409
// when a cell opens with neither key (nothing written) or changed under the
// write (rolled back, call again), 500 when the keys are misconfigured.

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) {
    return gate.status === 200
      ? NextResponse.json({ error: "not_enabled" }, { status: 503, headers: NO_STORE })
      : gate;
  }

  const step = await reencryptStep();
  switch (step.kind) {
    case "ok":
      return NextResponse.json(
        { done: step.done, reencrypted: step.reencrypted, remaining: step.remaining },
        { headers: NO_STORE },
      );
    case "failed":
      return NextResponse.json(
        { done: false, reencrypted: 0, remaining: step.remaining, failed: step.failed },
        { status: 409, headers: NO_STORE },
      );
    case "conflict":
      return NextResponse.json(
        { done: false, reencrypted: 0, remaining: step.remaining, conflict: true },
        { status: 409, headers: NO_STORE },
      );
    case "misconfigured":
      return NextResponse.json({ error: "keys_misconfigured" }, { status: 500, headers: NO_STORE });
  }
}
