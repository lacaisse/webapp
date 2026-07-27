// SPDX-License-Identifier: AGPL-3.0-or-later

// Merge rules for editing a member's answers to a fund's custom questions.
//
// Split out of the action because the interesting behaviour is not the write,
// it's what happens to answers the edit form never showed. A fund archives a
// question; the member's old answer must survive an unrelated edit rather than
// being wiped by a form that no longer renders it.
//
// Pure module (no Prisma, no server-only) so it can be unit-tested.

import type { ExtraValue } from "./schema";

export function mergeApplicationData(
  existing: Record<string, ExtraValue>,
  editableKeys: Iterable<string>,
  submitted: Record<string, ExtraValue | undefined>,
): Record<string, ExtraValue> {
  // Start from what's stored so answers outside the editable set — archived
  // questions, or keys from a form the fund has since changed — are carried
  // through untouched.
  const next: Record<string, ExtraValue> = { ...existing };

  for (const key of editableKeys) {
    const value = submitted[key];
    // An emptied answer is removed rather than stored as "" or [], so
    // "unanswered" has exactly one representation everywhere downstream.
    if (isEmptyAnswer(value)) delete next[key];
    else next[key] = normalizeAnswer(value!);
  }

  return next;
}

export function isEmptyAnswer(value: ExtraValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  // An unticked checkbox is not an answer — same rule the signup action uses.
  if (typeof value === "boolean") return value === false;
  return false;
}

export function normalizeAnswer(value: ExtraValue): ExtraValue {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value;
}
