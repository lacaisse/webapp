// SPDX-License-Identifier: AGPL-3.0-or-later

// In-memory, per-instance throttle for the public top-up poll: CP (and the
// mint path) is hit at most once per POLL_MIN_INTERVAL_MS per top-up, however
// often the poll is called. Best effort only — serverless instances don't
// share it, which is fine for a cost guard (the mint itself is guarded in the
// database). Pure apart from its own map.

const POLL_MIN_INTERVAL_MS = 2_000;
const MAX_ENTRIES = 5_000;
const lastPoll = new Map<string, number>();

export function takePollSlot(topUpId: string, now: number = Date.now()): boolean {
  const last = lastPoll.get(topUpId);
  if (last != null && now - last < POLL_MIN_INTERVAL_MS) return false;
  if (lastPoll.size >= MAX_ENTRIES) lastPoll.clear();
  lastPoll.set(topUpId, now);
  return true;
}
