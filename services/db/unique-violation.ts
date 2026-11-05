// SPDX-License-Identifier: AGPL-3.0-or-later

// Prisma P2002 (unique constraint failed) on a unique that includes `field`,
// e.g. "email" on User, "domain" on Fund, "paymentReference" on Member.
// `meta.target` is the column list (`["email"]`) or, with some drivers, the
// constraint name (`"User_email_key"`): both name the column. Pure, so the
// insert-and-catch pattern (no SELECT-then-INSERT) can be unit-tested with a
// hand-built error.
export function isUniqueViolationOn(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
