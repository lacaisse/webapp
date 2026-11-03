// SPDX-License-Identifier: AGPL-3.0-or-later

// The progress of a conversion as people see it: one line per step a leg
// declares (Leg.steps), with the fold applied the way walk.ts applies it —
// an exact leg's calls and the next leg's calls are ONE Safe transaction, so
// one line. Pure; module map: services/convert/assets.ts.

import type { ConversionState, StepKind, StepResult } from "./types";

export type ProgressState = "done" | "active" | "pending";

export type ProgressStep = {
  // Translation key under `fund.safes.conversion.progress`: `<legId>.<kind>`,
  // or `<exactLegId>+<legId>.calls` for a folded Safe transaction.
  key: string;
  state: ProgressState;
  txHash: string | null; // the Safe transaction, or the settlement for a fill
};

type LegShape = { id: string; exact: boolean; steps: readonly StepKind[] };

function resultOf(results: StepResult[], kind: StepKind): StepResult | undefined {
  return results.find((r) => r.kind === kind);
}

export function conversionProgress(
  legs: readonly LegShape[],
  state: ConversionState,
  done = false,
): ProgressStep[] {
  const out: { key: string; done: boolean; txHash: string | null }[] = [];
  let folded: string | null = null; // the exact leg whose calls wait for the next batch
  legs.forEach((leg, i) => {
    const results = state.legs[i]?.results ?? [];
    for (const kind of leg.steps) {
      if (kind === "calls" && leg.exact && i + 1 < legs.length) {
        folded = leg.id; // shown with the next leg's calls step
        continue;
      }
      const r = resultOf(results, kind);
      const key = kind === "calls" && folded ? `${folded}+${leg.id}.calls` : `${leg.id}.${kind}`;
      if (kind === "calls") folded = null;
      out.push({
        key,
        done: Boolean(r),
        txHash: r && (r.kind === "calls" || r.kind === "wait") ? r.txHash : null,
      });
    }
  });
  let activeSeen = false;
  return out.map((s) => {
    if (s.done || done) return { key: s.key, state: "done", txHash: s.txHash };
    const progressState: ProgressState = activeSeen ? "pending" : "active";
    activeSeen = true;
    return { key: s.key, state: progressState, txHash: s.txHash };
  });
}
