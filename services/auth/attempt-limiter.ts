// SPDX-License-Identifier: AGPL-3.0-or-later

// Small in-memory failure counter for the password re-auth action: after
// `max` failed attempts within `windowMs` a key is locked until the window
// slides past. Server actions bypass Better Auth's endpoint rate limiter, so
// this keeps a stolen session from brute-forcing the step-up password at
// full speed. Best-effort by design (per process / per lambda instance): the
// real protection against guessing is the password itself.

export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** True while `key` may still try. */
  allowed(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length < this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
